
const { router: paymentRouter, setPool: setPaymentPool, setNotificationService, setEmailService, setBroadcastService } = require('./routes/payment.routes');
const emailService = require('./services/email.service');
const SessionService = require('./services/session.service');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const moment = require('moment');
const QRCode = require('qrcode');
const crypto = require('crypto');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'tvnadrenaline_super_secret_2025';

// Middleware
app.use(cors());
app.use(express.json());

// MySQL Connection Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'TVNAdrenaline',
  ssl: {
    rejectUnauthorized: true
  },
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 0
});;

// Khởi tạo SessionService
const sessionService = new SessionService(pool);

setPaymentPool(pool);

// ==================== WEBSOCKET SETUP ====================
const clients = new Map(); // userId -> { ws, role, centerId }

wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection');

  let userId = null;
  let userRole = null;
  let sessionId = null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'auth' && data.token && data.sessionToken && data.deviceId) {
        jwt.verify(data.token, JWT_SECRET, async (err, user) => {
          if (err) {
            ws.send(JSON.stringify({
              type: 'auth_failed',
              error: 'Token không hợp lệ'
            }));
            ws.close();
            return;
          }

          const sessionData = await sessionService.verifySession(
            data.sessionToken,
            data.deviceId
          );

          if (!sessionData || sessionData.userId !== user.id) {
            ws.send(JSON.stringify({
              type: 'auth_failed',
              error: 'Session không hợp lệ hoặc đã hết hạn'
            }));
            ws.close();
            return;
          }

          const oldClient = clients.get(user.id);
          if (oldClient?.ws.readyState === WebSocket.OPEN) {
            oldClient.ws.send(JSON.stringify({
              type: 'force_logout',
              message: 'Tài khoản của bạn đã đăng nhập từ thiết bị khác'
            }));
            oldClient.ws.close();
            clients.delete(user.id);
            console.log(`Kicked out old WebSocket for user ${user.id}`);
          }

          userId = user.id;
          userRole = user.role;
          sessionId = sessionData.sessionId;

          let centerId = null;
          if (userRole === 'staff' || userRole === 'admin') {
            const [rows] = await pool.query(
              'SELECT centerId FROM Users WHERE id = ?',
              [userId]
            );
            if (rows[0]?.centerId) centerId = rows[0].centerId;
          }

          clients.set(userId, { ws, role: userRole, centerId, sessionId });

          ws.send(JSON.stringify({
            type: 'auth_success',
            userId,
            role: userRole
          }));

          console.log(`✅ User ${userId} (${userRole}) connected via WebSocket`);
        });
      }

      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }

    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  });

  ws.on('close', () => {
    if (userId) {
      clients.delete(userId);
      console.log(`User ${userId} disconnected from WebSocket`);
    }
  });
});

setInterval(() => {
  sessionService.cleanupExpiredSessions();
}, 60 * 60 * 1000);

setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ==================== HELPER FUNCTIONS ====================
const sendNotification = async (userId, title, message, type = 'info') => {
  let notificationId = null;
  try {
    const [result] = await pool.execute(
      `INSERT INTO Notifications (userId, title, message, type) VALUES (?, ?, ?, ?)`,
      [userId, title, message, type]
    );
    notificationId = result.insertId;
    console.log(`Đã lưu thông báo vào DB: ID=${notificationId}, userId=${userId}`);
  } catch (err) {
    console.error('Lỗi lưu thông báo vào DB:', err);
    return;
  }

  const payload = {
    type: 'new_notification',
    data: {
      id: notificationId,
      userId,
      title,
      message,
      type,
      isRead: false,
      createdAt: new Date().toISOString()
    }
  };

  const client = clients.get(userId);
  if (client?.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(payload));
    console.log(`Đã gửi thông báo real-time đến user ${userId}: ${title}`);
  } else {
    console.log(` User ${userId} không online, chỉ lưu DB`);
  }
};

const broadcastToStaff = (centerId, message) => {
  let count = 0;
  clients.forEach((client, userId) => {
    if (client.ws.readyState === WebSocket.OPEN &&
        (client.role === 'admin' || client.centerId == centerId)) {
      client.ws.send(JSON.stringify(message));
      count++;
    }
  });
  if (count > 0) console.log(`Broadcast to ${count} staff tại trung tâm ${centerId}`);
};

const sendToUser = (userId, message) => {
  const client = clients.get(userId);
  if (client?.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(message));
  }
};

const broadcastSlotUpdate = (centerId, date) => {
  const msg = { type: 'slots_updated', centerId, date };
  clients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg));
    }
  });
};

// ✅ EXPORT CHO PAYMENT ROUTES
setNotificationService(sendNotification);
setEmailService(emailService);
setBroadcastService(broadcastToStaff, sendToUser);

// ==================== JWT Middleware ====================
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Token không hợp lệ hoặc hết hạn' });
    req.user = user;
    next();
  });
};

const authorizeRole = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Không đủ quyền truy cập' });
    }
    next();
  };
};

// ====================== AUTH ROUTES ======================
app.post('/api/auth/register', async (req, res) => {
  const { name, phone, email, password } = req.body;
  if (!name || !phone || !email || !password) {
    return res.status(400).json({ message: 'Thiếu thông tin đăng ký' });
  }

  try {
    const hashed = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      `INSERT INTO Users (name, phone, email, password, role) VALUES (?, ?, ?, ?, 'user')`,
      [name, phone, email, hashed]
    );

    const userId = result.insertId;
    const token = jwt.sign(
      { id: userId, role: 'user', name },
      JWT_SECRET,
      { expiresIn: 7 * 24 * 60 * 60 }
    );

    res.status(201).json({
      message: 'Đăng ký thành công',
      token,
      user: { id: userId, name, phone, email, role: 'user' }
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'Số điện thoại hoặc email đã tồn tại' });
    }
    console.error('Register error:', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { emailOrPhone, password, deviceId, userAgent, ipAddress } = req.body;
  
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM Users WHERE email = ? OR phone = ?`,
      [emailOrPhone, emailOrPhone]
    );
    const user = rows[0];
    
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ message: 'Sai email/số điện thoại hoặc mật khẩu' });
    }
    
    if (!user.isActive) {
      return res.status(403).json({ message: 'Tài khoản bị khóa' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: 7 * 24 * 60 * 60 }
    );

    const deviceInfo = {
      deviceId: deviceId || req.headers['x-device-id'] || 'unknown',
      userAgent: userAgent || req.headers['user-agent'] || 'unknown',
      ipAddress: ipAddress || req.ip || req.connection.remoteAddress || '0.0.0.0'
    };

    const { sessionToken, expiresAt } = await sessionService.createSession(
      user.id,
      deviceInfo
    );

    const oldClient = clients.get(user.id);
    if (oldClient?.ws.readyState === WebSocket.OPEN) {
      oldClient.ws.send(JSON.stringify({
        type: 'force_logout',
        message: 'Tài khoản của bạn đã đăng nhập từ thiết bị khác'
      }));
      oldClient.ws.close();
      clients.delete(user.id);
      console.log(`Kicked out old device for user ${user.id}`);
    }

    res.json({
      message: 'Đăng nhập thành công',
      token,
      sessionToken,
      expiresAt,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  const { sessionToken, deviceId } = req.body;
  
  try {
    await sessionService.deleteSession(
      sessionToken,
      deviceId || req.headers['x-device-id'] || 'unknown'
    );

    const client = clients.get(req.user.id);
    if (client?.ws.readyState === WebSocket.OPEN) {
      client.ws.close();
      clients.delete(req.user.id);
    }

    res.json({ message: 'Đăng xuất thành công' });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi đăng xuất' });
  }
});

app.get('/api/my/sessions', authenticateToken, async (req, res) => {
  try {
    const sessions = await sessionService.getActiveSessions(req.user.id);
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/auth/logout-all', authenticateToken, async (req, res) => {
  try {
    await sessionService.deleteAllSessions(req.user.id);

    const client = clients.get(req.user.id);
    if (client?.ws.readyState === WebSocket.OPEN) {
      client.ws.close();
      clients.delete(req.user.id);
    }

    res.json({ message: 'Đã đăng xuất tất cả thiết bị' });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi đăng xuất' });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    return res.status(400).json({ message: 'Vui lòng nhập email' });
  }
  
  try {
    const [[user]] = await pool.query(
      'SELECT * FROM Users WHERE email = ?', 
      [email]
    );
    
    if (!user) {
      return res.status(404).json({ message: 'Email không tồn tại trong hệ thống' });
    }
    
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    
    await pool.execute(
      `INSERT INTO PasswordResetOTPs (userId, email, otp, expiresAt, ipAddress, userAgent) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [user.id, email, otp, expiresAt, req.ip, req.headers['user-agent']]
    );
    
    await emailService.sendResetPasswordOTP(email, {
      name: user.name,
      otp: otp,
      expiresIn: 10
    });
    
    res.json({ 
      message: 'Mã OTP đã được gửi đến email của bạn',
      email: email.replace(/(.{2})(.*)(@.*)/, '$1***$3')
    });
    
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ message: 'Lỗi server, vui lòng thử lại' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  
  if (!email || !otp) {
    return res.status(400).json({ message: 'Thiếu thông tin bắt buộc' });
  }
  
  try {
    const [[otpRecord]] = await pool.query(
      `SELECT * FROM PasswordResetOTPs 
       WHERE email = ? AND otp = ? AND isUsed = FALSE AND expiresAt > NOW() 
       ORDER BY createdAt DESC LIMIT 1`,
      [email, otp]
    );
    
    if (!otpRecord) {
      return res.status(400).json({ 
        message: 'Mã OTP không hợp lệ hoặc đã hết hạn' 
      });
    }
    
    res.json({ 
      message: 'Xác thực OTP thành công',
      success: true 
    });
    
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  
  if (!email || !otp || !newPassword) {
    return res.status(400).json({ message: 'Thiếu thông tin bắt buộc' });
  }
  
  if (newPassword.length < 6) {
    return res.status(400).json({ message: 'Mật khẩu phải có ít nhất 6 ký tự' });
  }
  
  try {
    const [[otpRecord]] = await pool.query(
      `SELECT * FROM PasswordResetOTPs 
       WHERE email = ? AND otp = ? AND isUsed = FALSE AND expiresAt > NOW() 
       ORDER BY createdAt DESC LIMIT 1`,
      [email, otp]
    );
    
    if (!otpRecord) {
      return res.status(400).json({ 
        message: 'OTP không hợp lệ hoặc đã hết hạn' 
      });
    }
    
    const hashedPassword = await bcrypt.hash(newPassword, 12);
    
    await pool.execute(
      'UPDATE Users SET password = ? WHERE id = ?',
      [hashedPassword, otpRecord.userId]
    );
    
    await pool.execute(
      'UPDATE PasswordResetOTPs SET isUsed = TRUE, usedAt = NOW() WHERE id = ?',
      [otpRecord.id]
    );
    
    res.json({ message: 'Đặt lại mật khẩu thành công! Vui lòng đăng nhập lại.' });
    
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ message: 'Lỗi server, vui lòng thử lại' });
  }
});

// ====================== THÊM VÀO SERVER.JS - SAU AUTH ROUTES ======================

// ✅ XÓA TÀI KHOẢN
app.delete('/api/auth/account', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 1. Kiểm tra lịch tiêm sắp tới
    const [upcomingBookings] = await connection.query(
      `SELECT COUNT(*) as count 
       FROM VaccinationBookings vb
       JOIN TimeSlots ts ON vb.timeSlotId = ts.id
       WHERE vb.userId = ? 
         AND vb.status IN ('pending', 'confirmed')
         AND ts.slotDate >= CURDATE()`,
      [userId]
    );

    if (upcomingBookings[0].count > 0) {
      await connection.rollback();
      return res.status(400).json({ 
        message: `Không thể xóa tài khoản! Bạn còn ${upcomingBookings[0].count} lịch tiêm chưa hoàn thành.` 
      });
    }

    // 2. Xóa tất cả sessions
    await connection.execute(
      'DELETE FROM UserSessions WHERE userId = ?',
      [userId]
    );

    // 3. Xóa notifications
    await connection.execute(
      'DELETE FROM Notifications WHERE userId = ?',
      [userId]
    );

    // 4. Xóa password reset OTPs
    await connection.execute(
      'DELETE FROM PasswordResetOTPs WHERE userId = ?',
      [userId]
    );

    // 5. KHÔNG XÓA bookings (giữ lại lịch sử) - chỉ anonymize
    await connection.execute(
      `UPDATE VaccinationBookings 
       SET parentName = 'Đã xóa tài khoản',
           parentPhone = 'N/A',
           notes = CONCAT(COALESCE(notes, ''), ' [Tài khoản đã xóa]')
       WHERE userId = ?`,
      [userId]
    );

    // 6. Xóa user
    await connection.execute(
      'DELETE FROM Users WHERE id = ?',
      [userId]
    );

    await connection.commit();

    // 7. Ngắt WebSocket nếu đang kết nối
    const client = clients.get(userId);
    if (client?.ws.readyState === WebSocket.OPEN) {
      client.ws.close();
      clients.delete(userId);
    }

    console.log(`✅ Đã xóa tài khoản user ${userId}`);

    res.json({ 
      message: 'Tài khoản đã được xóa thành công',
      success: true
    });

  } catch (err) {
    await connection.rollback();
    console.error('Lỗi xóa tài khoản:', err);
    res.status(500).json({ 
      message: 'Lỗi server: ' + err.message 
    });
  } finally {
    connection.release();
  }
});

// ✅ CẬP NHẬT THÔNG TIN CÁ NHÂN
app.patch('/api/auth/profile', authenticateToken, async (req, res) => {
  const { name, phone } = req.body;
  const userId = req.user.id;

  if (!name?.trim() || !phone?.trim()) {
    return res.status(400).json({ message: 'Vui lòng điền đầy đủ thông tin' });
  }

  // Validate phone
  if (!/(84|0[3|5|7|8|9])+([0-9]{8})\b/.test(phone)) {
    return res.status(400).json({ message: 'Số điện thoại không hợp lệ' });
  }

  try {
    // Kiểm tra phone đã tồn tại chưa (trừ user hiện tại)
    const [[existingPhone]] = await pool.query(
      'SELECT id FROM Users WHERE phone = ? AND id != ?',
      [phone.trim(), userId]
    );

    if (existingPhone) {
      return res.status(400).json({ message: 'Số điện thoại đã được sử dụng' });
    }

    await pool.execute(
      'UPDATE Users SET name = ?, phone = ? WHERE id = ?',
      [name.trim(), phone.trim(), userId]
    );

    // Lấy thông tin user mới
    const [[updatedUser]] = await pool.query(
      'SELECT id, name, phone, email, role FROM Users WHERE id = ?',
      [userId]
    );

    res.json({
      message: 'Cập nhật thành công',
      user: updatedUser
    });

  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ====================== PUBLIC ROUTES ======================
app.get('/api/centers', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM VaccinationCenters WHERE isActive = 1`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/vaccines', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM Vaccines WHERE isActive = 1`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/timeslots/available', async (req, res) => {
  console.log('\n=== [DEBUG] /api/timeslots/available ĐƯỢC GỌI ===');
  console.log('Query params:', req.query);

  const { centerId, date } = req.query;
  if (!centerId || !date) {
    console.log('Thiếu centerId hoặc date → 400');
    return res.status(400).json({ message: 'Thiếu centerId hoặc date' });
  }

  let currentUserId = null;
  const authHeader = req.headers['authorization'];
  const token = authHeader?.split(' ')[1];

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      currentUserId = decoded.id;
      console.log('Token hợp lệ → User ID:', currentUserId);
    } catch (err) {
      console.log('Token hết hạn hoặc sai → bỏ qua');
    }
  }

  try {
    const [rows] = await pool.query(
      `SELECT 
         id,
         slotTime,
         isBooked,
         tempReserved,
         reservedBy,
         reservedUntil,
         CASE WHEN reservedBy = ? THEN 1 ELSE 0 END AS isReservedByMe
       FROM TimeSlots 
       WHERE centerId = ? 
         AND slotDate = ?
         AND isActive = 1
         AND isBooked = 0
         AND (
           tempReserved = 0 OR
           reservedBy = ? OR
           reservedUntil IS NULL OR
           reservedUntil < NOW()
         )
       ORDER BY slotTime`,
      [currentUserId || null, centerId, date, currentUserId || null]
    );

    console.log(`Query trả về ${rows.length} slot khả dụng`);
    res.json(rows);
  } catch (err) {
    console.error('LỖI QUERY DATABASE:', err);
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// ====================== USER ROUTES ======================
app.get('/api/my/bookings', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT vb.*, v.name as vaccineName, vc.name as centerName, ts.slotDate, ts.slotTime
       FROM VaccinationBookings vb
       JOIN Vaccines v ON vb.vaccineId = v.id
       JOIN VaccinationCenters vc ON vb.centerId = vc.id
       JOIN TimeSlots ts ON vb.timeSlotId = ts.id
       WHERE vb.userId = ? ORDER BY vb.bookingDate DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/timeslots/reserve', authenticateToken, async (req, res) => {
  const { timeSlotId } = req.body;
  const reservedUntil = moment().add(10, 'minutes').format('YYYY-MM-DD HH:mm:ss');
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    await connection.execute(
      `UPDATE TimeSlots SET tempReserved = 0, reservedBy = NULL, reservedUntil = NULL
       WHERE reservedBy = ? AND tempReserved = 1 AND reservedUntil > NOW()`,
      [req.user.id]
    );

    const [result] = await connection.execute(
      `UPDATE TimeSlots SET tempReserved = 1, reservedBy = ?, reservedUntil = ?
       WHERE id = ? AND isActive = 1 AND isBooked = 0 AND (tempReserved = 0 OR reservedBy = ?)`,
      [req.user.id, reservedUntil, timeSlotId, req.user.id]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(400).json({ message: 'Khung giờ đã được đặt hoặc đang được giữ' });
    }

    await connection.commit();

    const [[slot]] = await pool.query('SELECT centerId, slotDate FROM TimeSlots WHERE id = ?', [timeSlotId]);
    broadcastSlotUpdate(slot.centerId, slot.slotDate);

    res.json({ message: 'Đã giữ chỗ 10 phút', reservedUntil, timeSlotId });
  } catch (err) {
    await connection.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    connection.release();
  }
});

app.post('/api/timeslots/release', authenticateToken, async (req, res) => {
  const { timeSlotId } = req.body;
  try {
    const [result] = await pool.execute(
      `UPDATE TimeSlots SET tempReserved = 0, reservedBy = NULL, reservedUntil = NULL
       WHERE id = ? AND reservedBy = ?`,
      [timeSlotId, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({ message: 'Bạn không đang giữ khung giờ này' });
    }

    const [[slot]] = await pool.query('SELECT centerId, slotDate FROM TimeSlots WHERE id = ?', [timeSlotId]);
    broadcastSlotUpdate(slot.centerId, slot.slotDate);

    res.json({ message: 'Đã bỏ giữ chỗ', timeSlotId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ✅ TẠO BOOKING - CHỜ THANH TOÁN (PENDING + UNPAID)
app.post('/api/bookings', authenticateToken, async (req, res) => {
  const {
    childName, childBirthDate, childGender, parentName, parentPhone,
    vaccineId, doseNumber = 1, centerId, timeSlotId, notes
  } = req.body;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [[user]] = await connection.query(
      'SELECT email, name FROM Users WHERE id = ?',
      [req.user.id]
    );

    if (!user) {
      throw new Error('Không tìm thấy thông tin user');
    }

    const [[slot]] = await connection.query(
      `SELECT * FROM TimeSlots WHERE id = ? AND isActive = 1 FOR UPDATE`, 
      [timeSlotId]
    );

    if (!slot || slot.centerId != centerId || slot.isBooked ||
        (slot.tempReserved && slot.reservedBy !== req.user.id)) {
      throw new Error('Khung giờ không khả dụng');
    }

    const bookingCode = 'TVN' + Date.now().toString().slice(-8);

    const [result] = await connection.execute(
      `INSERT INTO VaccinationBookings 
      (bookingCode, userId, childName, childBirthDate, childGender, parentName, parentPhone,
       vaccineId, doseNumber, centerId, timeSlotId, notes, status, paymentStatus)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'unpaid')`,
      [bookingCode, req.user.id, childName, childBirthDate, childGender,
       parentName, parentPhone, vaccineId, doseNumber, centerId, timeSlotId, notes || null]
    );

    const bookingId = result.insertId;

    await connection.execute(
      `UPDATE TimeSlots SET isBooked = 1, bookedBy = ?, tempReserved = 0, reservedBy = NULL, reservedUntil = NULL
       WHERE id = ?`, 
      [req.user.id, timeSlotId]
    );

    await connection.commit();

    await sendNotification(
      req.user.id,
      'Đã tạo lịch hẹn',
      `Mã lịch: ${bookingCode}. Vui lòng thanh toán để hoàn tất đặt lịch cho bé ${childName}.`,
      'info'
    );

    broadcastSlotUpdate(centerId, slot.slotDate);

    res.json({ 
      message: 'Đã tạo lịch hẹn! Vui lòng thanh toán để hoàn tất.', 
      bookingCode, 
      bookingId,
      requiresPayment: true
    });

  } catch (err) {
    await connection.rollback();
    console.error('Lỗi đặt lịch:', err);
    res.status(400).json({ message: err.message });
  } finally {
    connection.release();
  }
});

// ==================== QR CODE ROUTES ====================
app.get('/api/bookings/:id/qr', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const [[booking]] = await pool.query(
      `SELECT 
         vb.id,
         vb.bookingCode,
         vb.childName,
         vb.centerId,
         vb.userId,
         vb.status,
         vb.paymentStatus,
         ts.slotDate,
         ts.slotTime
       FROM VaccinationBookings vb
       JOIN TimeSlots ts ON vb.timeSlotId = ts.id
       WHERE vb.id = ?`,
      [id]
    );

    if (!booking) {
      return res.status(404).json({ message: 'Không tìm thấy lịch đặt' });
    }

    if (booking.userId !== req.user.id) {
      return res.status(403).json({ message: 'Không có quyền truy cập' });
    }

    if (['cancelled', 'no_show'].includes(booking.status)) {
      return res.status(400).json({ 
        message: 'Không thể tạo QR cho lịch đã hủy hoặc không đến' 
      });
    }

    if (booking.paymentStatus === 'unpaid') {
      return res.status(400).json({ 
        message: 'Vui lòng hoàn tất thanh toán trước khi xem QR code',
        code: 'PAYMENT_REQUIRED'
      });
    }

    const qrPayload = {
      bookingId: booking.id,
      bookingCode: booking.bookingCode,
      childName: booking.childName,
      centerId: booking.centerId,
      status: booking.status,
      timestamp: Date.now(),
    };

    const signature = crypto
      .createHash('sha256')
      .update(`${booking.id}-${booking.bookingCode}-${JWT_SECRET}`)
      .digest('hex')
      .slice(0, 16);

    qrPayload.signature = signature;

    const qrString = JSON.stringify(qrPayload);

    const qrImage = await QRCode.toDataURL(qrString, {
      width: 400,
      margin: 2,
      color: { dark: '#0d9488', light: '#ffffff' }
    });

    let validUntil = null;
    
    try {
      if (booking.slotDate && booking.slotTime) {
        let dateStr;
        if (typeof booking.slotDate === 'string') {
          dateStr = booking.slotDate.split('T')[0];
        } else if (booking.slotDate instanceof Date) {
          dateStr = booking.slotDate.toISOString().split('T')[0];
        } else {
          dateStr = booking.slotDate;
        }
        
        let timeStr;
        if (typeof booking.slotTime === 'string') {
          timeStr = booking.slotTime.slice(0, 8);
        } else {
          timeStr = booking.slotTime.toString().slice(0, 8);
        }
        
        const dateTimeStr = `${dateStr}T${timeStr}`;
        const dateObj = new Date(dateTimeStr);
        
        if (!isNaN(dateObj.getTime())) {
          validUntil = dateObj.toISOString();
        }
      }
    } catch (err) {
      console.error('Error parsing validUntil:', err);
    }

    res.json({
      qrCode: qrImage,
      qrData: qrPayload,
      validUntil: validUntil,
      status: booking.status,
      note: booking.status === 'confirmed' 
        ? 'QR code đã sẵn sàng. Vui lòng mang theo khi đến trung tâm.'
        : null
    });
    
  } catch (err) {
    console.error('QR generation error:', err);
    res.status(500).json({ 
      message: 'Lỗi tạo QR', 
      error: err.message
    });
  }
});

app.post('/api/staff/qr-checkin', authenticateToken, authorizeRole('staff', 'admin'), async (req, res) => {
  const { qrData } = req.body;
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    let parsedData;
    try {
      parsedData = typeof qrData === 'string' ? JSON.parse(qrData) : qrData;
    } catch {
      throw new Error('QR code không hợp lệ');
    }
    
    const { bookingId, bookingCode, signature } = parsedData;
    
    const expectedSignature = crypto
      .createHash('sha256')
      .update(`${bookingId}-${bookingCode}-${JWT_SECRET}`)
      .digest('hex')
      .slice(0, 16);
    
    if (signature !== expectedSignature) {
      throw new Error('QR code không hợp lệ hoặc đã bị giả mạo');
    }
    
    const [[booking]] = await connection.query(
      `SELECT vb.*, v.name as vaccineName, ts.slotTime
      FROM VaccinationBookings vb
      LEFT JOIN Vaccines v ON vb.vaccineId = v.id
      LEFT JOIN TimeSlots ts ON vb.timeSlotId = ts.id
      WHERE vb.id = ? AND vb.bookingCode = ?`,
      [bookingId, bookingCode]
    );
    
    if (!booking) {
      throw new Error('Không tìm thấy lịch đặt');
    }
    
    const [[staff]] = await connection.query(
      'SELECT centerId FROM Users WHERE id = ?',
      [req.user.id]
    );
    
    if (staff.centerId != booking.centerId) {
      throw new Error('Lịch đặt không thuộc trung tâm của bạn');
    }
    
    if (booking.status === 'completed') {
      throw new Error('Lịch đặt đã hoàn thành trước đó');
    }
    
    if (booking.status === 'cancelled') {
      throw new Error('Lịch đặt đã bị hủy');
    }
    
    if (booking.status === 'no_show') {
      throw new Error('Lịch đặt đã bị đánh dấu không đến');
    }

    // ✅ SỬ DỤNG PARAMETERIZED QUERY
    const [updateResult] = await connection.execute(
      'UPDATE VaccinationBookings SET status = ? WHERE id = ?',
      ['checked_in', bookingId]
    );

    console.log(`QR Check-in update result:`, updateResult);

    if (updateResult.affectedRows === 0) {
      throw new Error('Không thể cập nhật trạng thái');
    }

    // ✅ VERIFY
    const [[verifyBooking]] = await connection.query(
      'SELECT status FROM VaccinationBookings WHERE id = ?',
      [bookingId]
    );

    console.log(`Verified status:`, verifyBooking.status);
    
    await connection.commit();

    console.log(`QR Check-in booking ${bookingId} → status: ${verifyBooking.status}`);
    
    await sendNotification(
      booking.userId,
      'Check-in thành công qua QR',
      `Bé ${booking.childName} đã được check-in bằng QR code. Vui lòng chờ gọi số.`,
      'success'
    );
    
    broadcastToStaff(booking.centerId, {
      type: 'checked_in',
      bookingId: bookingId,
      centerId: booking.centerId,
      method: 'qr'
    });

    sendToUser(booking.userId, {
      type: 'booking_status_changed',
      bookingId: bookingId,
      status: 'checked_in'
    });
    
    res.json({
      message: 'Check-in thành công!',
      booking: {
        id: booking.id,
        bookingCode: booking.bookingCode,
        childName: booking.childName,
        parentName: booking.parentName,
        vaccineName: booking.vaccineName || 'N/A',
        slotTime: booking.slotTime,
        status: 'checked_in'
      }
    });
    
  } catch (err) {
    await connection.rollback();
    console.error('QR check-in error:', err);
    res.status(400).json({ message: err.message });
  } finally {
    connection.release();
  }
});
// ==================== FIX CANCEL BOOKING ENDPOINT ====================
app.patch('/api/bookings/:id/cancel', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // ✅ 1. LẤY THÔNG TIN USER
    const [[user]] = await connection.query(
      'SELECT email, name FROM Users WHERE id = ?',
      [req.user.id]
    );

    // ✅ 2. LẤY THÔNG TIN BOOKING
    const [[booking]] = await connection.query(
      `SELECT vb.*, ts.slotDate, ts.slotTime, vc.name as centerName 
       FROM VaccinationBookings vb
       JOIN TimeSlots ts ON vb.timeSlotId = ts.id
       JOIN VaccinationCenters vc ON vb.centerId = vc.id
       WHERE vb.id = ? AND vb.userId = ?`,
      [id, req.user.id]
    );

    if (!booking) {
      await connection.rollback();
      return res.status(404).json({ message: 'Không tìm thấy lịch hẹn' });
    }

    console.log('\n=== [DEBUG CANCEL] ===');
    console.log('Booking Status:', booking.status);
    console.log('Payment Status:', booking.paymentStatus);
    console.log('Slot Date:', booking.slotDate);
    console.log('Slot Time:', booking.slotTime);

    // ✅ 3. KIỂM TRA TRẠNG THÁI - CHO PHÉP HỦY CẢ PENDING VÀ CONFIRMED
    const allowedStatuses = ['pending', 'confirmed', 'paid_pending'];
    if (!allowedStatuses.includes(booking.status)) {
      await connection.rollback();
      return res.status(400).json({ 
        message: `Không thể hủy lịch có trạng thái: ${booking.status}` 
      });
    }

    // ✅ 4. KIỂM TRA THỜI GIAN (CHỈ ÁP DỤNG CHO CONFIRMED)
    if (booking.status === 'confirmed') {
      let emailDate = 'N/A';
      let emailTime = 'N/A';
      let slotDateTime = null;
      
      try {
        let dateStr;
        if (booking.slotDate instanceof Date) {
          dateStr = booking.slotDate.toISOString().split('T')[0];
        } else if (typeof booking.slotDate === 'string') {
          dateStr = booking.slotDate.split('T')[0];
        } else {
          dateStr = String(booking.slotDate).split(' ')[0];
        }

        let timeStr = '08:00:00';
        if (typeof booking.slotTime === 'string') {
          timeStr = booking.slotTime.slice(0, 8);
        } else if (booking.slotTime) {
          timeStr = String(booking.slotTime).slice(0, 8);
        }

        slotDateTime = moment(`${dateStr} ${timeStr}`, 'YYYY-MM-DD HH:mm:ss', true);
        
        if (slotDateTime.isValid()) {
          emailDate = slotDateTime.format('DD/MM/YYYY');
          emailTime = slotDateTime.format('HH:mm');

          // Kiểm tra 24 giờ
          const hoursDiff = slotDateTime.diff(moment(), 'hours');
          console.log('Hours until appointment:', hoursDiff);
          
          if (hoursDiff < 24) {
            await connection.rollback();
            return res.status(400).json({ 
              message: 'Chỉ được hủy trước 24 giờ. Vui lòng liên hệ hotline để được hỗ trợ.' 
            });
          }
        }
      } catch (err) {
        console.error('Date parsing error:', err.message);
        // Nếu không parse được date, cho phép hủy
      }
    }

    // ✅ 5. CẬP NHẬT TRẠNG THÁI
    await connection.execute(
      `UPDATE VaccinationBookings 
       SET status = 'cancelled', paymentStatus = 'refunded' 
       WHERE id = ?`,
      [id]
    );

    // ✅ 6. GIẢI PHÓNG SLOT
    await connection.execute(
      `UPDATE TimeSlots 
       SET isBooked = 0, bookedBy = NULL 
       WHERE id = ?`,
      [booking.timeSlotId]
    );

    await connection.commit();
    
    console.log(`✅ Đã hủy booking ${id} thành công`);
    
    res.json({ message: 'Hủy lịch thành công' });

    // ✅ 7. GỬI EMAIL & NOTIFICATION (ASYNC - KHÔNG BLOCK RESPONSE)
    if (user && user.email) {
      let emailDate = 'N/A';
      let emailTime = 'N/A';
      
      try {
        let dateStr;
        if (booking.slotDate instanceof Date) {
          dateStr = booking.slotDate.toISOString().split('T')[0];
        } else if (typeof booking.slotDate === 'string') {
          dateStr = booking.slotDate.split('T')[0];
        } else {
          dateStr = String(booking.slotDate).split(' ')[0];
        }

        let timeStr = '08:00:00';
        if (typeof booking.slotTime === 'string') {
          timeStr = booking.slotTime.slice(0, 8);
        } else if (booking.slotTime) {
          timeStr = String(booking.slotTime).slice(0, 8);
        }

        const slotDateTime = moment(`${dateStr} ${timeStr}`, 'YYYY-MM-DD HH:mm:ss', true);
        if (slotDateTime.isValid()) {
          emailDate = slotDateTime.format('DD/MM/YYYY');
          emailTime = slotDateTime.format('HH:mm');
        }
      } catch (err) {
        console.error('Date format error:', err);
      }

      const emailData = {
        bookingCode: booking.bookingCode,
        childName: booking.childName,
        slotDate: emailDate,
        slotTime: emailTime,
        parentName: user.name,
        centerName: booking.centerName || 'N/A',
        reason: req.body?.reason || null
      };
      
      emailService.sendCancellation(user.email, emailData)
        .then(() => console.log(`✉️  Cancellation email sent to ${user.email}`))
        .catch(err => console.error('❌ Email error:', err.message));
    }

    sendNotification(
      req.user.id,
      'Đã hủy lịch thành công',
      `Lịch tiêm của bé ${booking.childName} (Mã: ${booking.bookingCode}) đã được hủy. Slot đã được giải phóng.`,
      'info'
    ).catch(err => console.error('❌ Notification error:', err.message));

    broadcastToStaff(booking.centerId, {
      type: 'booking_cancelled',
      bookingId: id,
      bookingCode: booking.bookingCode,
      childName: booking.childName,
      centerId: booking.centerId
    });

  } catch (err) {
    await connection.rollback();
    console.error('❌ Lỗi hủy lịch:', err);
    console.error('Stack:', err.stack);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        message: 'Lỗi server: ' + err.message,
        error: process.env.NODE_ENV === 'development' ? err.stack : undefined
      });
    }
  } finally {
    connection.release();
  }
});
// ====================== STAFF & ADMIN ROUTES ======================
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, phone, email, role FROM Users WHERE id = ?', 
      [req.user.id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ message: 'User không tồn tại' });
    }
    
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/my/notifications', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM Notifications 
       WHERE userId = ? 
       ORDER BY createdAt DESC 
       LIMIT 50`, 
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.patch('/api/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    await pool.execute(
      'UPDATE Notifications SET isRead = 1 WHERE id = ? AND userId = ?', 
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Đánh dấu đã đọc' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/staff/me', authenticateToken, authorizeRole('staff', 'admin'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.phone, u.email, u.role, u.centerId, 
              vc.name as centerName, vc.address as centerAddress
       FROM Users u
       LEFT JOIN VaccinationCenters vc ON u.centerId = vc.id
       WHERE u.id = ?`,
      [req.user.id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Staff không tồn tại' });
    }
    
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/staff/bookings', authenticateToken, authorizeRole('staff', 'admin'), async (req, res) => {
  const { date, status } = req.query;
  
  try {
    const [[staff]] = await pool.query(
      'SELECT centerId FROM Users WHERE id = ?',
      [req.user.id]
    );
    
    if (!staff || !staff.centerId) {
      return res.status(400).json({ message: 'Staff chưa được gán trung tâm' });
    }
    
    let query = `
      SELECT vb.*, 
             u.name as userName, u.phone as userPhone,
             v.name as vaccineName, v.price as vaccinePrice,
             vc.name as centerName, 
             ts.slotDate, ts.slotTime
      FROM VaccinationBookings vb
      JOIN Users u ON vb.userId = u.id
      JOIN Vaccines v ON vb.vaccineId = v.id
      JOIN VaccinationCenters vc ON vb.centerId = vc.id
      JOIN TimeSlots ts ON vb.timeSlotId = ts.id
      WHERE vb.centerId = ?
    `;
    const params = [staff.centerId];
    
    if (date) {
      query += ` AND ts.slotDate = ?`;
      params.push(date);
    }
    
    if (status) {
      query += ` AND vb.status = ?`;
      params.push(status);
    }
    
    query += ` ORDER BY ts.slotDate ASC, ts.slotTime ASC`;
    
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/staff/send-notification', authenticateToken, authorizeRole('staff', 'admin'), async (req, res) => {
  const { userId, title, message, type = 'info' } = req.body;
  
  if (!userId || !title || !message) {
    return res.status(400).json({ message: 'Thiếu thông tin bắt buộc' });
  }
  
  try {
    // Kiểm tra user có tồn tại không
    const [[user]] = await pool.query('SELECT id, name FROM Users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy người dùng' });
    }
    
    await sendNotification(userId, title, message, type);
    
    res.json({ 
      message: 'Đã gửi thông báo thành công',
      sentTo: user.name
    });
  } catch (err) {
    console.error('Lỗi gửi thông báo:', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

app.get('/api/staff/users', authenticateToken, authorizeRole('staff', 'admin'), async (req, res) => {
  const { search } = req.query;
  
  try {
    const [[staff]] = await pool.query('SELECT centerId FROM Users WHERE id = ?', [req.user.id]);
    
    if (!staff || !staff.centerId) {
      return res.status(400).json({ message: 'Staff chưa được gán trung tâm' });
    }
    
    let query = `
      SELECT DISTINCT u.id, u.name, u.phone, u.email
      FROM Users u
      JOIN VaccinationBookings vb ON u.id = vb.userId
      WHERE vb.centerId = ? AND u.role = 'user' AND u.isActive = 1
    `;
    const params = [staff.centerId];
    
    if (search && search.length >= 2) {
      query += ` AND (u.name LIKE ? OR u.phone LIKE ? OR u.email LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    
    query += ` ORDER BY u.name ASC LIMIT 50`;
    
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.patch('/api/staff/bookings/:id/checkin', authenticateToken, authorizeRole('staff', 'admin'), async (req, res) => {
  const { id } = req.params;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // ✅ 1. LẤY THÔNG TIN BOOKING
    console.log(`[CHECK-IN] Step 1: Fetching booking ${id}...`);
    const [[booking]] = await connection.query(
      'SELECT * FROM VaccinationBookings WHERE id = ?', 
      [id]
    );
    
    if (!booking) {
      console.error(`[CHECK-IN] Booking ${id} not found`);
      await connection.rollback();
      return res.status(404).json({ message: 'Không tìm thấy lịch' });
    }

    console.log(`[CHECK-IN] Booking found:`, {
      id: booking.id,
      status: booking.status,
      paymentStatus: booking.paymentStatus
    });

    // ✅ 2. KIỂM TRA TRẠNG THÁI
    if (booking.status === 'checked_in') {
      await connection.rollback();
      return res.status(400).json({ message: 'Khách đã check-in rồi' });
    }

    if (booking.status === 'completed') {
      await connection.rollback();
      return res.status(400).json({ message: 'Lịch đã hoàn thành' });
    }

    if (!['confirmed', 'paid_pending'].includes(booking.status)) {
      await connection.rollback();
      return res.status(400).json({ 
        message: `Không thể check-in. Trạng thái hiện tại: ${booking.status}` 
      });
    }

    // ✅ 3. UPDATE STATUS
    console.log(`[CHECK-IN] Step 2: Updating status to checked_in...`);
    const [updateResult] = await connection.execute(
      'UPDATE VaccinationBookings SET status = ? WHERE id = ?',
      ['checked_in', id]
    );

    console.log(`[CHECK-IN] Update result:`, updateResult);

    if (updateResult.affectedRows === 0) {
      console.error(`[CHECK-IN] No rows affected for booking ${id}`);
      await connection.rollback();
      return res.status(500).json({ message: 'Không thể cập nhật trạng thái' });
    }

    // ✅ 4. VERIFY UPDATE
    console.log(`[CHECK-IN] Step 3: Verifying update...`);
    const [[verifyBooking]] = await connection.query(
      'SELECT status FROM VaccinationBookings WHERE id = ?',
      [id]
    );

    console.log(`[CHECK-IN] Verified status:`, verifyBooking.status);

    if (verifyBooking.status !== 'checked_in') {
      console.error(`[CHECK-IN] Status mismatch. Expected: checked_in, Got: ${verifyBooking.status}`);
      await connection.rollback();
      return res.status(500).json({ 
        message: 'Lỗi xác nhận trạng thái',
        expected: 'checked_in',
        actual: verifyBooking.status
      });
    }

    await connection.commit();
    console.log(`✅ [CHECK-IN] Successfully checked in booking ${id}`);

    // ✅ 5. NOTIFICATIONS
    await sendNotification(
      booking.userId,
      'Đã check-in thành công',
      `Bé ${booking.childName} đã được check-in. Vui lòng chờ gọi số.`,
      'info'
    ).catch(err => console.error('Notification error:', err));

    broadcastToStaff(booking.centerId, {
      type: 'checked_in',
      bookingId: id,
      centerId: booking.centerId
    });

    sendToUser(booking.userId, {
      type: 'booking_status_changed',
      bookingId: id,
      status: 'checked_in'
    });

    res.json({ 
      message: 'Check-in thành công',
      booking: { 
        id: booking.id, 
        status: 'checked_in' 
      }
    });

  } catch (err) {
    await connection.rollback();
    console.error('[CHECK-IN] Error:', err);
    console.error('Stack trace:', err.stack);
    res.status(500).json({ 
      message: 'Lỗi check-in: ' + err.message,
      error: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  } finally {
    connection.release();
  }
});

app.post('/api/staff/bookings/:id/complete', authenticateToken, authorizeRole('staff', 'admin'), async (req, res) => {
  const { id } = req.params;
  const { batchNumber } = req.body;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [[booking]] = await connection.query('SELECT * FROM VaccinationBookings WHERE id = ?', [id]);
    if (!booking) throw new Error('Không tìm thấy lịch');

    await connection.execute('UPDATE VaccinationBookings SET status = "completed", paymentStatus = "paid" WHERE id = ?', [id]);
    await connection.commit();

    await sendNotification(
      booking.userId,
      '🎉 Tiêm thành công!',
      `Bé ${booking.childName} đã được tiêm thành công! Số lô: ${batchNumber || 'N/A'}. Cảm ơn quý phụ huynh!`,
      'success'
    );

    broadcastToStaff(booking.centerId, {
      type: 'injection_completed',
      bookingId: id,
      centerId: booking.centerId
    });

    res.json({ message: 'Tiêm thành công' });
  } catch (err) {
    await connection.rollback();
    res.status(400).json({ message: err.message });
  } finally {
    connection.release();
  }
});

app.patch('/api/staff/bookings/:id/no-show', authenticateToken, authorizeRole('staff', 'admin'), async (req, res) => {
  const { id } = req.params;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [[booking]] = await connection.query('SELECT * FROM VaccinationBookings WHERE id = ?', [id]);
    if (!booking) throw new Error('Không tìm thấy lịch');

    await connection.execute('UPDATE VaccinationBookings SET status = "no_show" WHERE id = ?', [id]);
    await connection.execute('UPDATE TimeSlots SET isBooked = 0, bookedBy = NULL WHERE id = ?', [booking.timeSlotId]);
    await connection.commit();

    await sendNotification(
      booking.userId,
      'Lịch hẹn bị hủy',
      `Lịch tiêm của bé ${booking.childName} đã bị hủy do không đến đúng giờ.`,
      'warning'
    );

    broadcastToStaff(booking.centerId, {
      type: 'marked_no_show',
      bookingId: id,
      centerId: booking.centerId
    });

    res.json({ message: 'Đã đánh dấu no-show' });
  } catch (err) {
    await connection.rollback();
    res.status(400).json({ message: err.message });
  } finally {
    connection.release();
  }
});

app.get('/api/staff/stats', authenticateToken, authorizeRole('staff', 'admin'), async (req, res) => {
  const { date } = req.query;
  const targetDate = date || moment().format('YYYY-MM-DD');
  
  try {
    const [[staff]] = await pool.query('SELECT centerId FROM Users WHERE id = ?', [req.user.id]);
    
    if (!staff || !staff.centerId) {
      return res.status(400).json({ message: 'Staff chưa được gán trung tâm' });
    }
    
    const [[total]] = await pool.query(
      `SELECT COUNT(*) as total FROM VaccinationBookings vb
       JOIN TimeSlots ts ON vb.timeSlotId = ts.id
       WHERE vb.centerId = ? AND ts.slotDate = ?`,
      [staff.centerId, targetDate]
    );
    
    const [statusCount] = await pool.query(
      `SELECT vb.status, COUNT(*) as count 
       FROM VaccinationBookings vb
       JOIN TimeSlots ts ON vb.timeSlotId = ts.id
       WHERE vb.centerId = ? AND ts.slotDate = ?
       GROUP BY vb.status`,
      [staff.centerId, targetDate]
    );
    
    const [vaccineUsage] = await pool.query(
      `SELECT v.name, COUNT(*) as count
       FROM VaccinationBookings vb
       JOIN TimeSlots ts ON vb.timeSlotId = ts.id
       JOIN Vaccines v ON vb.vaccineId = v.id
       WHERE vb.centerId = ? AND ts.slotDate = ? AND vb.status = 'completed'
       GROUP BY v.id`,
      [staff.centerId, targetDate]
    );
    
    res.json({
      date: targetDate,
      total: total.total || 0,
      byStatus: statusCount,
      vaccineUsage
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/staff/search', authenticateToken, authorizeRole('staff', 'admin'), async (req, res) => {
  const { q } = req.query;
  
  if (!q || q.length < 3) {
    return res.status(400).json({ message: 'Vui lòng nhập ít nhất 3 ký tự' });
  }
  
  try {
    const [[staff]] = await pool.query('SELECT centerId FROM Users WHERE id = ?', [req.user.id]);
    
    if (!staff || !staff.centerId) {
      return res.status(400).json({ message: 'Staff chưa được gán trung tâm' });
    }
    
    const [rows] = await pool.query(
      `SELECT vb.*, 
              u.name as userName, u.phone as userPhone,
              v.name as vaccineName,
              vc.name as centerName,
              ts.slotDate, ts.slotTime
       FROM VaccinationBookings vb
       JOIN Users u ON vb.userId = u.id
       JOIN Vaccines v ON vb.vaccineId = v.id
       JOIN VaccinationCenters vc ON vb.centerId = vc.id
       JOIN TimeSlots ts ON vb.timeSlotId = ts.id
       WHERE vb.centerId = ?
         AND (
           vb.bookingCode LIKE ? OR
           vb.childName LIKE ? OR
           vb.parentName LIKE ? OR
           vb.parentPhone LIKE ?
         )
       ORDER BY ts.slotDate DESC, ts.slotTime DESC
       LIMIT 20`,
      [staff.centerId, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`]
    );
    
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ✅ ADMIN DASHBOARD
app.get('/api/admin/dashboard', authenticateToken, authorizeRole('admin'), async (req, res) => {
  try {
    // Tổng số users
    const [[userCount]] = await pool.query(
      `SELECT COUNT(*) as total FROM Users WHERE role = 'user'`
    );
    
    // Tổng số staff
    const [[staffCount]] = await pool.query(
      `SELECT COUNT(*) as total FROM Users WHERE role = 'staff'`
    );
    
    // Tổng số bookings
    const [[bookingCount]] = await pool.query(
      `SELECT COUNT(*) as total FROM VaccinationBookings`
    );
    
    // Bookings hôm nay
    const [[todayBookings]] = await pool.query(
      `SELECT COUNT(*) as total FROM VaccinationBookings 
       WHERE DATE(bookingDate) = CURDATE()`
    );
    
    // Bookings theo status
    const [statusStats] = await pool.query(
      `SELECT status, COUNT(*) as count FROM VaccinationBookings 
       GROUP BY status`
    );
    
    // Bookings 7 ngày gần nhất
    const [weeklyStats] = await pool.query(
      `SELECT DATE(bookingDate) as date, COUNT(*) as count 
       FROM VaccinationBookings 
       WHERE bookingDate >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       GROUP BY DATE(bookingDate)
       ORDER BY date ASC`
    );
    
    // Top vaccines
    const [topVaccines] = await pool.query(
      `SELECT v.name, COUNT(*) as count 
       FROM VaccinationBookings vb
       JOIN Vaccines v ON vb.vaccineId = v.id
       GROUP BY v.id
       ORDER BY count DESC
       LIMIT 5`
    );
    
    // Top centers
    const [topCenters] = await pool.query(
      `SELECT vc.name, COUNT(*) as count 
       FROM VaccinationBookings vb
       JOIN VaccinationCenters vc ON vb.centerId = vc.id
       GROUP BY vc.id
       ORDER BY count DESC
       LIMIT 5`
    );
    
    // Doanh thu ước tính (tháng này)
    const [[revenue]] = await pool.query(
      `SELECT SUM(v.price) as total
       FROM VaccinationBookings vb
       JOIN Vaccines v ON vb.vaccineId = v.id
       WHERE MONTH(vb.bookingDate) = MONTH(CURDATE())
         AND YEAR(vb.bookingDate) = YEAR(CURDATE())
         AND vb.status = 'completed'`
    );
    
    res.json({
      users: userCount.total,
      staff: staffCount.total,
      bookings: bookingCount.total,
      todayBookings: todayBookings.total,
      statusStats,
      weeklyStats,
      topVaccines,
      topCenters,
      revenue: revenue.total || 0
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 2. QUẢN LÝ USERS
app.get('/api/admin/users', authenticateToken, authorizeRole('admin'), async (req, res) => {
  const { search, status, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  
  try {
    let query = `SELECT id, name, phone, email, role, isActive, createdAt 
                 FROM Users WHERE role = 'user'`;
    let countQuery = `SELECT COUNT(*) as total FROM Users WHERE role = 'user'`;
    const params = [];
    const countParams = [];
    
    if (search) {
      query += ` AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)`;
      countQuery += ` AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      countParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    
    if (status === 'active') {
      query += ` AND isActive = 1`;
      countQuery += ` AND isActive = 1`;
    } else if (status === 'inactive') {
      query += ` AND isActive = 0`;
      countQuery += ` AND isActive = 0`;
    }
    
    query += ` ORDER BY createdAt DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));
    
    const [users] = await pool.query(query, params);
    const [[{ total }]] = await pool.query(countQuery, countParams);
    
    res.json({
      users,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Khóa/Mở khóa user
app.patch('/api/admin/users/:id/toggle-status', authenticateToken, authorizeRole('admin'), async (req, res) => {
  const { id } = req.params;
  
  try {
    const [[user]] = await pool.query('SELECT isActive FROM Users WHERE id = ?', [id]);
    if (!user) return res.status(404).json({ message: 'User không tồn tại' });
    
    const newStatus = !user.isActive;
    await pool.execute('UPDATE Users SET isActive = ? WHERE id = ?', [newStatus, id]);
    
    res.json({ 
      message: newStatus ? 'Đã mở khóa user' : 'Đã khóa user',
      isActive: newStatus
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 3. QUẢN LÝ STAFF
app.get('/api/admin/staff', authenticateToken, authorizeRole('admin'), async (req, res) => {
  try {
    const [staff] = await pool.query(
      `SELECT u.*, vc.name as centerName 
       FROM Users u
       LEFT JOIN VaccinationCenters vc ON u.centerId = vc.id
       WHERE u.role = 'staff'
       ORDER BY u.createdAt DESC`
    );
    res.json(staff);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Thêm staff mới
app.post('/api/admin/staff', authenticateToken, authorizeRole('admin'), async (req, res) => {
  const { name, phone, email, password, centerId } = req.body;
  
  if (!name || !phone || !email || !password) {
    return res.status(400).json({ message: 'Thiếu thông tin bắt buộc' });
  }
  
  try {
    const hashed = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      `INSERT INTO Users (name, phone, email, password, role, centerId) 
       VALUES (?, ?, ?, ?, 'staff', ?)`,
      [name, phone, email, hashed, centerId || null]
    );
    
    res.status(201).json({ 
      message: 'Thêm staff thành công',
      staffId: result.insertId
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'Email hoặc số điện thoại đã tồn tại' });
    }
    res.status(500).json({ message: err.message });
  }
});

// Cập nhật staff
app.put('/api/admin/staff/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { name, phone, email, centerId } = req.body;
  
  try {
    await pool.execute(
      `UPDATE Users SET name = ?, phone = ?, email = ?, centerId = ? 
       WHERE id = ? AND role = 'staff'`,
      [name, phone, email, centerId || null, id]
    );
    
    res.json({ message: 'Cập nhật staff thành công' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Xóa staff
app.delete('/api/admin/staff/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  const { id } = req.params;
  
  try {
    await pool.execute('DELETE FROM Users WHERE id = ? AND role = "staff"', [id]);
    res.json({ message: 'Xóa staff thành công' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 4. QUẢN LÝ TRUNG TÂM
app.get('/api/admin/centers', authenticateToken, authorizeRole('admin'), async (req, res) => {
  try {
    const [centers] = await pool.query(
      `SELECT *, 
        (SELECT COUNT(*) FROM Users WHERE centerId = VaccinationCenters.id AND role = 'staff') as staffCount,
        (SELECT COUNT(*) FROM VaccinationBookings WHERE centerId = VaccinationCenters.id) as bookingCount
       FROM VaccinationCenters 
       ORDER BY createdAt DESC`
    );
    res.json(centers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Thêm trung tâm
app.post('/api/admin/centers', authenticateToken, authorizeRole('admin'), async (req, res) => {
  const { name, address, phone, openHours, latitude, longitude } = req.body;
  
  if (!name || !address) {
    return res.status(400).json({ message: 'Thiếu thông tin bắt buộc' });
  }
  
  try {
    const [result] = await pool.execute(
      `INSERT INTO VaccinationCenters (name, address, phone, openHours, latitude, longitude) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, address, phone || null, openHours || '07:30 - 17:30', latitude || null, longitude || null]
    );
    
    res.status(201).json({ 
      message: 'Thêm trung tâm thành công',
      centerId: result.insertId
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Cập nhật trung tâm
app.put('/api/admin/centers/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { name, address, phone, openHours, latitude, longitude, isActive } = req.body;
  
  try {
    await pool.execute(
      `UPDATE VaccinationCenters 
       SET name = ?, address = ?, phone = ?, openHours = ?, latitude = ?, longitude = ?, isActive = ?
       WHERE id = ?`,
      [name, address, phone, openHours, latitude, longitude, isActive, id]
    );
    
    res.json({ message: 'Cập nhật trung tâm thành công' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Xóa trung tâm (soft delete)
app.delete('/api/admin/centers/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  const { id } = req.params;
  
  try {
    await pool.execute('UPDATE VaccinationCenters SET isActive = 0 WHERE id = ?', [id]);
    res.json({ message: 'Đã vô hiệu hóa trung tâm' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 5. QUẢN LÝ VACCINE
app.get('/api/admin/vaccines', authenticateToken, authorizeRole('admin'), async (req, res) => {
  try {
    const [vaccines] = await pool.query(
      `SELECT v.*,
        (SELECT COUNT(*) FROM VaccinationBookings WHERE vaccineId = v.id) as bookingCount
       FROM Vaccines v 
       ORDER BY createdAt DESC`
    );
    res.json(vaccines);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Thêm vaccine
app.post('/api/admin/vaccines', authenticateToken, authorizeRole('admin'), async (req, res) => {
  const { name, shortName, manufacturer, targetAge, doseInfo, price, stock, description } = req.body;
  
  if (!name || !price) {
    return res.status(400).json({ message: 'Thiếu thông tin bắt buộc' });
  }
  
  try {
    const [result] = await pool.execute(
      `INSERT INTO Vaccines (name, shortName, manufacturer, targetAge, doseInfo, price, stock, description) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, shortName, manufacturer, targetAge, doseInfo, price, stock || 0, description]
    );
    
    res.status(201).json({ 
      message: 'Thêm vaccine thành công',
      vaccineId: result.insertId
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Cập nhật vaccine
app.put('/api/admin/vaccines/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { name, shortName, manufacturer, targetAge, doseInfo, price, stock, description, isActive } = req.body;
  
  try {
    await pool.execute(
      `UPDATE Vaccines 
       SET name = ?, shortName = ?, manufacturer = ?, targetAge = ?, doseInfo = ?, 
           price = ?, stock = ?, description = ?, isActive = ?
       WHERE id = ?`,
      [name, shortName, manufacturer, targetAge, doseInfo, price, stock, description, isActive, id]
    );
    
    res.json({ message: 'Cập nhật vaccine thành công' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Xóa vaccine (soft delete)
app.delete('/api/admin/vaccines/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  const { id } = req.params;
  
  try {
    await pool.execute('UPDATE Vaccines SET isActive = 0 WHERE id = ?', [id]);
    res.json({ message: 'Đã vô hiệu hóa vaccine' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// ====================== PAYMENT ROUTES ======================
app.use('/api/payment', paymentRouter);

// ====================== CLEANUP JOBS ======================
setInterval(async () => {
  try {
    const [result] = await pool.execute(
      `UPDATE TimeSlots 
       SET tempReserved = 0, reservedBy = NULL, reservedUntil = NULL
       WHERE tempReserved = 1 AND reservedUntil < NOW()`
    );
    
    if (result.affectedRows > 0) {
      console.log(`Đã dọn ${result.affectedRows} slot tạm giữ hết hạn`);
    }
  } catch (err) {
    console.error('Lỗi dọn slot:', err);
  }
}, 2 * 60 * 1000);

setInterval(async () => {
  try {
    const [expiredBookings] = await pool.query(
      `SELECT vb.id, vb.bookingCode, vb.timeSlotId, vb.userId, vb.childName
       FROM VaccinationBookings vb
       WHERE vb.status = 'pending' 
         AND vb.paymentStatus = 'unpaid'
         AND vb.bookingDate < DATE_SUB(NOW(), INTERVAL 30 MINUTE)`
    );

    if (expiredBookings.length > 0) {
      for (const booking of expiredBookings) {
        await pool.execute('UPDATE VaccinationBookings SET status = "cancelled" WHERE id = ?', [booking.id]);
        await pool.execute('UPDATE TimeSlots SET isBooked = 0, bookedBy = NULL WHERE id = ?', [booking.timeSlotId]);
        await sendNotification(
          booking.userId,
          'Lịch hẹn đã hết hạn',
          `Lịch ${booking.bookingCode} đã hủy do không thanh toán trong 30 phút.`,
          'warning'
        );
      }
    }
  } catch (err) {
    console.error('Lỗi auto-cancel:', err);
  }
}, 5 * 60 * 1000);

// ====================== START SERVER ======================
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║   TVNAdrenaline Backend                               ║
║   Port: ${PORT}                                       ║
║   WebSocket: ws://localhost:${PORT}                   ║
║   Started: ${new Date().toLocaleString('vi-VN')}      ║
╚═══════════════════════════════════════════════════════╝
  `);
  
  cron.schedule('0 9 * * *', async () => {
    console.log('🔔 Running reminder email job...');
    // Email reminder logic here
  });
});

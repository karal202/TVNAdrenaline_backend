// routes/payment.routes.js - BỎ QUA PAID_PENDING, CHUYỂN THẲNG CONFIRMED
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

let pool;
let sendNotification;
let emailService;
let broadcastToStaff;
let sendToUser;

const setPool = (dbPool) => { pool = dbPool; };
const setNotificationService = (notificationFn) => { sendNotification = notificationFn; };
const setEmailService = (emailSvc) => { emailService = emailSvc; };
const setBroadcastService = (broadcastFn, sendToUserFn) => {
  broadcastToStaff = broadcastFn;
  sendToUser = sendToUserFn;
};

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Access token required' });

  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET || 'tvnadrenaline_super_secret_2025';
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Token không hợp lệ hoặc hết hạn' });
    req.user = user;
    next();
  });
};

const MOMO_CONFIG = {
  partnerCode: process.env.MOMO_PARTNER_CODE || 'MOMOBKUN20180529',
  accessKey: process.env.MOMO_ACCESS_KEY || 'klm05TvNBzhg7h7j',
  secretKey: process.env.MOMO_SECRET_KEY || 'at67qH6mk8w5Y1nAyMoYKMWACiEi2bsa',
  endpoint: process.env.MOMO_ENDPOINT || 'https://test-payment.momo.vn/v2/gateway/api/create',
  redirectUrl: process.env.MOMO_REDIRECT_URL || 'http://localhost:3000/api/payment/momo/callback',
  ipnUrl: process.env.MOMO_IPN_URL || 'http://localhost:3000/api/payment/momo/ipn'
};

const generateMoMoSignature = (data) => {
  const rawSignature = `accessKey=${data.accessKey}&amount=${data.amount}&extraData=${data.extraData}&ipnUrl=${data.ipnUrl}&orderId=${data.orderId}&orderInfo=${data.orderInfo}&partnerCode=${data.partnerCode}&redirectUrl=${data.redirectUrl}&requestId=${data.requestId}&requestType=${data.requestType}`;
  return crypto.createHmac('sha256', MOMO_CONFIG.secretKey).update(rawSignature).digest('hex');
};

// ✅ HÀM GỬI EMAIL + NOTIFICATION SAU THANH TOÁN (CONFIRMED THAY VÌ PAID_PENDING)
async function sendBookingSuccessNotifications(bookingId) {
  if (!pool) {
    console.error('❌ Pool not initialized');
    return;
  }

  try {
    const [[booking]] = await pool.query(
      `SELECT vb.*, u.email, u.name as userName,
              v.name as vaccineName, v.price as vaccinePrice,
              vc.name as centerName, vc.address as centerAddress, vc.phone as centerPhone,
              ts.slotDate, ts.slotTime
       FROM VaccinationBookings vb
       JOIN Users u ON vb.userId = u.id
       JOIN Vaccines v ON vb.vaccineId = v.id
       JOIN VaccinationCenters vc ON vb.centerId = vc.id
       JOIN TimeSlots ts ON vb.timeSlotId = ts.id
       WHERE vb.id = ?`,
      [bookingId]
    );

    if (!booking) {
      console.error('❌ Booking not found:', bookingId);
      return;
    }

    console.log(`📨 Sending success notifications for booking ${bookingId}`);

    // Format date/time
    let slotDateStr = booking.slotDate instanceof Date 
      ? booking.slotDate.toISOString().split('T')[0]
      : String(booking.slotDate).split('T')[0];
    
    const timeStr = String(booking.slotTime).slice(0, 5);

    // ✅ 1. GỬI EMAIL XÁC NHẬN (KHÔNG PHẢI "CHỜ DUYỆT")
    if (emailService && booking.email) {
      console.log(`📧 Sending booking confirmation email to: ${booking.email}`);
      
      emailService.sendBookingConfirmation(booking.email, {
        bookingCode: booking.bookingCode,
        childName: booking.childName,
        vaccineName: booking.vaccineName,
        slotDate: slotDateStr,
        slotTime: timeStr,
        centerName: booking.centerName,
        centerAddress: booking.centerAddress || 'N/A',
        centerPhone: booking.centerPhone || 'N/A',
        parentName: booking.userName
      }).then(() => {
        console.log(`✅ Confirmation email sent to ${booking.email}`);
      }).catch(err => {
        console.error('❌ Email error:', err.message);
      });
    }

    // ✅ 2. GỬI THÔNG BÁO WEB REALTIME
    if (sendNotification) {
      sendNotification(
        booking.userId,
        '🎉 Đặt lịch thành công!',
        `Thanh toán thành công! Lịch tiêm cho bé ${booking.childName} (Mã: ${booking.bookingCode}) đã được xác nhận tại ${booking.centerName}. Vui lòng đến đúng giờ hẹn!`,
        'success'
      ).then(() => {
        console.log(`✅ Notification sent to user ${booking.userId}`);
      }).catch(err => {
        console.error('❌ Notification error:', err.message);
      });
    }

    // ✅ 3. BROADCAST CHO STAFF (booking_confirmed)
    if (broadcastToStaff) {
      broadcastToStaff(booking.centerId, {
        type: 'booking_confirmed',
        data: {
          bookingId: booking.id,
          bookingCode: booking.bookingCode,
          childName: booking.childName,
          parentName: booking.parentName,
          parentPhone: booking.parentPhone,
          vaccineName: booking.vaccineName,
          doseNumber: booking.doseNumber,
          slotDate: slotDateStr,
          slotTime: timeStr,
          status: 'confirmed',
          paymentStatus: 'paid',
          centerId: booking.centerId
        }
      });
    }

    // ✅ 4. GỬI ĐẾN USER (real-time update)
    if (sendToUser) {
      sendToUser(booking.userId, {
        type: 'booking_status_changed',
        bookingId: booking.id,
        status: 'confirmed',
        paymentStatus: 'paid'
      });
    }

    console.log(`✅ All post-payment notifications sent for booking ${bookingId}`);

  } catch (error) {
    console.error('❌ Error sending post-payment notifications:', error);
  }
}

// ==================== CREATE PAYMENT ====================

router.post('/momo/create', authenticateToken, async (req, res) => {
  const { bookingId, amount } = req.body;

  if (!bookingId || !amount) {
    return res.status(400).json({ message: 'Thiếu thông tin bookingId hoặc amount' });
  }

  if (!pool) {
    return res.status(500).json({ message: 'Database chưa được khởi tạo' });
  }

  try {
    const [[booking]] = await pool.query(
      'SELECT * FROM VaccinationBookings WHERE id = ? AND userId = ?',
      [bookingId, req.user.id]
    );

    if (!booking) {
      return res.status(404).json({ message: 'Không tìm thấy booking' });
    }

    if (booking.paymentStatus === 'paid') {
      return res.status(400).json({ message: 'Booking đã được thanh toán' });
    }

    const orderId = `TVN_${bookingId}_${Date.now()}`;
    const requestId = orderId;

    const paymentData = {
      partnerCode: MOMO_CONFIG.partnerCode,
      accessKey: MOMO_CONFIG.accessKey,
      requestId: requestId,
      amount: amount.toString(),
      orderId: orderId,
      orderInfo: `Thanh toan tiem chung - Booking #${booking.bookingCode}`,
      redirectUrl: MOMO_CONFIG.redirectUrl,
      ipnUrl: MOMO_CONFIG.ipnUrl,
      requestType: 'payWithATM',
      extraData: Buffer.from(JSON.stringify({ bookingId, userId: req.user.id })).toString('base64'),
      lang: 'vi'
    };

    paymentData.signature = generateMoMoSignature(paymentData);

    const response = await axios.post(MOMO_CONFIG.endpoint, paymentData, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    if (response.data.resultCode === 0) {
      await pool.execute(
        `INSERT INTO PaymentTransactions (bookingId, userId, amount, paymentMethod, transactionId, status)
         VALUES (?, ?, ?, 'momo', ?, 'pending')`,
        [bookingId, req.user.id, amount, orderId]
      );

      res.json({
        success: true,
        payUrl: response.data.payUrl,
        orderId: orderId
      });
    } else {
      throw new Error(response.data.message || 'Lỗi tạo thanh toán MoMo');
    }
  } catch (err) {
    console.error('💥 MoMo payment error:', err.response?.data || err.message);
    res.status(500).json({ 
      message: 'Lỗi tạo thanh toán MoMo', 
      error: err.response?.data?.message || err.message 
    });
  }
});

router.post('/vnpay/create', authenticateToken, async (req, res) => {
  const { bookingId, amount } = req.body;

  if (!bookingId || !amount) {
    return res.status(400).json({ message: 'Thiếu thông tin bookingId hoặc amount' });
  }

  if (!pool) {
    return res.status(500).json({ message: 'Database chưa được khởi tạo' });
  }

  try {
    const [[booking]] = await pool.query(
      'SELECT * FROM VaccinationBookings WHERE id = ? AND userId = ?',
      [bookingId, req.user.id]
    );

    if (!booking) {
      return res.status(404).json({ message: 'Không tìm thấy booking' });
    }

    if (booking.paymentStatus === 'paid') {
      return res.status(400).json({ message: 'Booking đã được thanh toán' });
    }

    const paymentService = require('../services/payment.service');
    const orderId = `TVN_${bookingId}_${Date.now()}`;
    
    const paymentData = paymentService.createVNPayPayment({
      orderId: orderId,
      amount: parseInt(amount),
      orderInfo: `Thanh toan tiem chung - Booking #${booking.bookingCode}`,
      ipAddr: req.ip || req.connection.remoteAddress || '127.0.0.1',
      bookingId: bookingId
    });

    if (paymentData.success && paymentData.payUrl) {
      await pool.execute(
        `INSERT INTO PaymentTransactions (bookingId, userId, amount, paymentMethod, transactionId, status)
         VALUES (?, ?, ?, 'vnpay', ?, 'pending')`,
        [bookingId, req.user.id, amount, orderId]
      );

      res.json({
        success: true,
        payUrl: paymentData.payUrl,
        orderId: orderId
      });
    } else {
      throw new Error('Lỗi tạo thanh toán VNPay');
    }
  } catch (err) {
    console.error('VNPay payment error:', err);
    res.status(500).json({ 
      message: 'Lỗi tạo thanh toán VNPay', 
      error: err.message 
    });
  }
});

// ==================== PAYMENT CALLBACKS ====================

router.get('/momo/callback', async (req, res) => {
  console.log('🔔 MoMo Return URL received:', req.query);

  const { orderId, resultCode, extraData, message } = req.query;

  try {
    let bookingId = null;
    if (extraData) {
      try {
        const decoded = JSON.parse(Buffer.from(extraData, 'base64').toString());
        bookingId = decoded.bookingId;
      } catch (err) {
        console.error('Error parsing extraData:', err);
      }
    }

    if (!bookingId && orderId) {
      const parts = orderId.split('_');
      if (parts.length >= 2) {
        bookingId = parts[1];
      }
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';

    if (resultCode === '0') {
      console.log(`✅ MoMo payment success for booking ${bookingId}`);
      
      if (pool && bookingId) {
        try {
          // ✅ CHUYỂN THẲNG SANG confirmed (BỎ QUA paid_pending)
          await pool.execute(
            'UPDATE VaccinationBookings SET paymentStatus = "paid", status = "confirmed", paymentMethod = "momo" WHERE id = ?',
            [bookingId]
          );

          await pool.execute(
            'UPDATE PaymentTransactions SET status = "success", paidAt = NOW() WHERE transactionId = ?',
            [orderId]
          );

          await sendBookingSuccessNotifications(bookingId);

        } catch (dbErr) {
          console.error('Error updating DB:', dbErr);
        }
      }

      return res.redirect(`${frontendUrl}/payment/success?orderId=${orderId}&amount=${req.query.amount || 0}`);
    } else {
      console.log(`❌ MoMo payment failed for booking ${bookingId}, code: ${resultCode}`);
      
      if (pool && orderId) {
        try {
          await pool.execute(
            'UPDATE PaymentTransactions SET status = "failed" WHERE transactionId = ?',
            [orderId]
          );
        } catch (dbErr) {
          console.error('Error updating DB:', dbErr);
        }
      }

      return res.redirect(`${frontendUrl}/payment/failure?message=${encodeURIComponent(message || 'Payment failed')}&bookingId=${bookingId || ''}`);
    }
  } catch (err) {
    console.error('❌ MoMo callback error:', err);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    return res.redirect(`${frontendUrl}/payment/failure?message=System+error`);
  }
});

router.post('/momo/ipn', async (req, res) => {
  console.log('🔔 MoMo IPN received:', req.body);

  const { orderId, resultCode, extraData, signature } = req.body;

  const rawSignature = `accessKey=${MOMO_CONFIG.accessKey}&amount=${req.body.amount}&extraData=${extraData}&message=${req.body.message}&orderId=${orderId}&orderInfo=${req.body.orderInfo}&orderType=${req.body.orderType}&partnerCode=${req.body.partnerCode}&payType=${req.body.payType}&requestId=${req.body.requestId}&responseTime=${req.body.responseTime}&resultCode=${resultCode}&transId=${req.body.transId}`;
  
  const expectedSignature = crypto
    .createHmac('sha256', MOMO_CONFIG.secretKey)
    .update(rawSignature)
    .digest('hex');

  if (signature !== expectedSignature) {
    console.error('❌ Invalid MoMo signature');
    return res.status(400).json({ message: 'Invalid signature' });
  }

  try {
    let bookingId = null;
    if (extraData) {
      try {
        const decodedData = JSON.parse(Buffer.from(extraData, 'base64').toString());
        bookingId = decodedData.bookingId;
      } catch (err) {
        console.error('Error parsing extraData:', err);
      }
    }

    if (!bookingId && orderId) {
      const parts = orderId.split('_');
      if (parts.length >= 2) {
        bookingId = parts[1];
      }
    }

    if (resultCode === 0) {
      if (pool && bookingId) {
        // ✅ CHUYỂN THẲNG SANG confirmed
        await pool.execute(
          'UPDATE VaccinationBookings SET paymentStatus = "paid", status = "confirmed", paymentMethod = "momo" WHERE id = ?',
          [bookingId]
        );

        await pool.execute(
          'UPDATE PaymentTransactions SET status = "success", paidAt = NOW() WHERE transactionId = ?',
          [orderId]
        );

        await sendBookingSuccessNotifications(bookingId);
      }

      console.log(`✅ MoMo IPN: Payment success for booking ${bookingId}`);
    } else {
      if (pool && orderId) {
        await pool.execute(
          'UPDATE PaymentTransactions SET status = "failed" WHERE transactionId = ?',
          [orderId]
        );
      }

      console.log(`❌ MoMo IPN: Payment failed for booking ${bookingId}`);
    }

    res.status(200).json({ message: 'OK' });
  } catch (err) {
    console.error('❌ MoMo IPN error:', err);
    res.status(500).json({ message: 'Internal error' });
  }
});

router.get('/vnpay/callback', async (req, res) => {
  console.log('🔔 VNPay callback received:', req.query);

  try {
    const paymentService = require('../services/payment.service');
    
    const vnpParams = { ...req.query };
    const isValid = paymentService.verifyVNPaySignature(vnpParams);

    if (!isValid) {
      console.error('❌ Invalid VNPay signature');
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3001'}/payment/failure?message=Invalid+signature`);
    }

    const { vnp_TxnRef, vnp_ResponseCode, vnp_Amount, vnp_TransactionNo } = req.query;
    
    const parts = vnp_TxnRef.split('_');
    const bookingId = parts.length >= 2 ? parts[1] : null;

    if (vnp_ResponseCode === '00') {
      if (pool && bookingId) {
        // ✅ CHUYỂN THẲNG SANG confirmed
        await pool.execute(
          'UPDATE VaccinationBookings SET paymentStatus = "paid", status = "confirmed", paymentMethod = "vnpay", paymentTransactionId = ? WHERE id = ?',
          [vnp_TransactionNo, bookingId]
        );

        await pool.execute(
          'UPDATE PaymentTransactions SET status = "success", paidAt = NOW() WHERE transactionId = ?',
          [vnp_TxnRef]
        );

        await sendBookingSuccessNotifications(bookingId);
      }

      console.log(`✅ VNPay payment success for booking ${bookingId}`);
      
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3001'}/payment/success?orderId=${vnp_TxnRef}&amount=${vnp_Amount / 100}`);
    } else {
      if (pool && vnp_TxnRef) {
        await pool.execute(
          'UPDATE PaymentTransactions SET status = "failed" WHERE transactionId = ?',
          [vnp_TxnRef]
        );
      }

      console.log(`❌ VNPay payment failed for booking ${bookingId}, code: ${vnp_ResponseCode}`);
      
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3001'}/payment/failure?message=Payment+failed&bookingId=${bookingId || ''}`);
    }
  } catch (err) {
    console.error('❌ VNPay callback error:', err);
    return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3001'}/payment/failure?message=System+error`);
  }
});

router.get('/vnpay/ipn', async (req, res) => {
  console.log('🔔 VNPay IPN received:', req.query);

  try {
    const paymentService = require('../services/payment.service');
    
    const vnpParams = { ...req.query };
    const isValid = paymentService.verifyVNPaySignature(vnpParams);

    if (!isValid) {
      return res.json({ RspCode: '97', Message: 'Invalid signature' });
    }

    const { vnp_TxnRef, vnp_ResponseCode, vnp_TransactionNo } = req.query;
    
    const parts = vnp_TxnRef.split('_');
    const bookingId = parts.length >= 2 ? parts[1] : null;

    if (vnp_ResponseCode === '00') {
      if (pool && bookingId) {
        // ✅ CHUYỂN THẲNG SANG confirmed
        await pool.execute(
          'UPDATE VaccinationBookings SET paymentStatus = "paid", status = "confirmed", paymentMethod = "vnpay", paymentTransactionId = ? WHERE id = ?',
          [vnp_TransactionNo, bookingId]
        );

        await pool.execute(
          'UPDATE PaymentTransactions SET status = "success", paidAt = NOW() WHERE transactionId = ?',
          [vnp_TxnRef]
        );

        await sendBookingSuccessNotifications(bookingId);
      }

      return res.json({ RspCode: '00', Message: 'Success' });
    } else {
      if (pool && vnp_TxnRef) {
        await pool.execute(
          'UPDATE PaymentTransactions SET status = "failed" WHERE transactionId = ?',
          [vnp_TxnRef]
        );
      }

      return res.json({ RspCode: '00', Message: 'Confirmed' });
    }
  } catch (err) {
    console.error('❌ VNPay IPN error:', err);
    return res.json({ RspCode: '99', Message: 'System error' });
  }
});

router.post('/cancel', authenticateToken, async (req, res) => {
  const { bookingId } = req.body;
  
  if (!bookingId) {
    return res.status(400).json({ message: 'Thiếu bookingId' });
  }

  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    const [[booking]] = await connection.query(
      `SELECT vb.*, ts.id as timeSlotId 
       FROM VaccinationBookings vb
       JOIN TimeSlots ts ON vb.timeSlotId = ts.id
       WHERE vb.id = ? AND vb.userId = ?`,
      [bookingId, req.user.id]
    );

    if (!booking) {
      await connection.rollback();
      return res.status(404).json({ message: 'Không tìm thấy booking' });
    }

    if (booking.paymentStatus === 'paid') {
      await connection.rollback();
      return res.status(400).json({ message: 'Booking đã thanh toán, không thể hủy' });
    }

    await connection.execute(
      `UPDATE VaccinationBookings 
       SET status = 'cancelled', paymentStatus = 'refunded' 
       WHERE id = ?`,
      [bookingId]
    );

    await connection.execute(
      `UPDATE TimeSlots 
       SET isBooked = 0, bookedBy = NULL 
       WHERE id = ?`,
      [booking.timeSlotId]
    );

    await connection.execute(
      `UPDATE PaymentTransactions 
       SET status = 'failed' 
       WHERE bookingId = ? AND status = 'pending'`,
      [bookingId]
    );

    await connection.commit();

    console.log(`✅ Đã hủy thanh toán và giải phóng slot cho booking ${bookingId}`);

    res.json({ 
      message: 'Đã hủy thanh toán và giải phóng slot thành công',
      bookingId 
    });

  } catch (err) {
    await connection.rollback();
    console.error('Lỗi hủy thanh toán:', err);
    res.status(500).json({ message: 'Lỗi server' });
  } finally {
    connection.release();
  }
});

router.get('/status/:bookingId', authenticateToken, async (req, res) => {
  const { bookingId } = req.params;

  if (!pool) {
    return res.status(500).json({ message: 'Database chưa được khởi tạo' });
  }

  try {
    const [[booking]] = await pool.query(
      'SELECT paymentStatus FROM VaccinationBookings WHERE id = ? AND userId = ?',
      [bookingId, req.user.id]
    );

    if (!booking) {
      return res.status(404).json({ message: 'Không tìm thấy booking' });
    }

    const [transactions] = await pool.query(
      'SELECT * FROM PaymentTransactions WHERE bookingId = ? ORDER BY createdAt DESC',
      [bookingId]
    );

    res.json({
      paymentStatus: booking.paymentStatus,
      transactions
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = {
  router,
  setPool,
  setNotificationService,
  setEmailService,
  setBroadcastService
};
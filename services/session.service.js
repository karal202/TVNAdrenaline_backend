// services/session.service.js - Quản lý session và ngăn đa thiết bị
const crypto = require('crypto');

class SessionService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Tạo session mới khi user login
   * Tự động kick session cũ nếu có
   */
  async createSession(userId, deviceInfo) {
    const { deviceId, userAgent, ipAddress } = deviceInfo;
    
    // ✅ Tạo session token unique
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 ngày

    const connection = await this.pool.getConnection();
    
    try {
      await connection.beginTransaction();

      // ❌ XÓA TẤT CẢ SESSION CŨ của user này
      await connection.execute(
        `DELETE FROM UserSessions WHERE userId = ?`,
        [userId]
      );

      // ✅ TẠO SESSION MỚI
      await connection.execute(
        `INSERT INTO UserSessions 
         (userId, sessionToken, deviceId, userAgent, ipAddress, expiresAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, sessionToken, deviceId, userAgent, ipAddress, expiresAt]
      );

      await connection.commit();

      console.log(`✅ Created new session for user ${userId}, device ${deviceId}`);
      
      return {
        sessionToken,
        expiresAt
      };

    } catch (err) {
      await connection.rollback();
      console.error('❌ Create session error:', err);
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * Verify session token
   * Trả về userId nếu hợp lệ, null nếu không
   */
  async verifySession(sessionToken, deviceId) {
    try {
      const [[session]] = await this.pool.query(
        `SELECT * FROM UserSessions 
         WHERE sessionToken = ? 
         AND deviceId = ? 
         AND expiresAt > NOW()
         AND isActive = 1`,
        [sessionToken, deviceId]
      );

      if (!session) {
        return null;
      }

      // Cập nhật lastActiveAt
      await this.pool.execute(
        `UPDATE UserSessions SET lastActiveAt = NOW() WHERE id = ?`,
        [session.id]
      );

      return {
        userId: session.userId,
        sessionId: session.id
      };

    } catch (err) {
      console.error('❌ Verify session error:', err);
      return null;
    }
  }

  /**
   * Kiểm tra xem có session nào khác đang active không
   */
  async hasActiveSession(userId, currentDeviceId) {
    try {
      const [[result]] = await this.pool.query(
        `SELECT COUNT(*) as count 
         FROM UserSessions 
         WHERE userId = ? 
         AND deviceId != ? 
         AND expiresAt > NOW()
         AND isActive = 1`,
        [userId, currentDeviceId]
      );

      return result.count > 0;
    } catch (err) {
      console.error('❌ Check active session error:', err);
      return false;
    }
  }

  /**
   * Logout - xóa session
   */
  async deleteSession(sessionToken, deviceId) {
    try {
      await this.pool.execute(
        `DELETE FROM UserSessions 
         WHERE sessionToken = ? AND deviceId = ?`,
        [sessionToken, deviceId]
      );

      console.log(`✅ Deleted session for device ${deviceId}`);
    } catch (err) {
      console.error('❌ Delete session error:', err);
    }
  }

  /**
   * Logout tất cả thiết bị
   */
  async deleteAllSessions(userId) {
    try {
      await this.pool.execute(
        `DELETE FROM UserSessions WHERE userId = ?`,
        [userId]
      );

      console.log(`✅ Deleted all sessions for user ${userId}`);
    } catch (err) {
      console.error('❌ Delete all sessions error:', err);
    }
  }

  /**
   * Lấy danh sách sessions active của user
   */
  async getActiveSessions(userId) {
    try {
      const [sessions] = await this.pool.query(
        `SELECT id, deviceId, userAgent, ipAddress, createdAt, lastActiveAt
         FROM UserSessions 
         WHERE userId = ? 
         AND expiresAt > NOW()
         AND isActive = 1
         ORDER BY lastActiveAt DESC`,
        [userId]
      );

      return sessions;
    } catch (err) {
      console.error('❌ Get active sessions error:', err);
      return [];
    }
  }

  /**
   * Dọn dẹp sessions hết hạn (chạy định kỳ)
   */
  async cleanupExpiredSessions() {
    try {
      const [result] = await this.pool.execute(
        `DELETE FROM UserSessions WHERE expiresAt < NOW()`
      );

      if (result.affectedRows > 0) {
        console.log(`🗑️ Cleaned up ${result.affectedRows} expired sessions`);
      }
    } catch (err) {
      console.error('❌ Cleanup sessions error:', err);
    }
  }
}

module.exports = SessionService;
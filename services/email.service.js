const nodemailer = require('nodemailer');
require('dotenv').config();

class EmailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
      }
    });

    this.from = `"TVNAdrenaline" <${process.env.EMAIL_USER}>`;
    this.validateConfig();
  }

  validateConfig() {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      console.warn('⚠️ Thiếu EMAIL_USER hoặc EMAIL_PASSWORD trong .env');
      console.warn('⚠️ Email service sẽ không hoạt động!');
    } else {
      console.log('✅ Email service initialized');
    }
  }

  // ==================== EMAIL TEMPLATES ====================

  /**
   * ✅ Template 1: Đặt lịch ban đầu (chưa xác nhận)
   */
  getBookingCreatedHTML(data) {
    const { bookingCode, childName, vaccineName, slotDate, slotTime, centerName, centerAddress, centerPhone, parentName } = data;
    
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
    .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
    .info-box { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; border-left: 4px solid #3b82f6; }
    .info-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
    .info-row:last-child { border-bottom: none; }
    .label { font-weight: bold; color: #6b7280; }
    .value { color: #111827; font-weight: 600; }
    .pending-notice { background: #dbeafe; border-left: 4px solid #3b82f6; padding: 15px; margin: 20px 0; border-radius: 8px; }
    .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0; font-size: 28px;">📝 Đặt lịch thành công!</h1>
      <p style="margin: 10px 0 0 0; font-size: 16px;">Mã đặt lịch: <strong>${bookingCode}</strong></p>
    </div>
    
    <div class="content">
      <p>Kính chào <strong>${parentName}</strong>,</p>
      <p>Cảm ơn quý phụ huynh đã tin tưởng sử dụng dịch vụ của TVNAdrenaline. Yêu cầu đặt lịch tiêm chủng cho bé <strong>${childName}</strong> đã được ghi nhận!</p>
      
      <div class="pending-notice">
        <strong>🔵 Trạng thái: Chờ xác nhận</strong>
        <p style="margin: 10px 0 0 0;">
          Lịch hẹn của bạn đang được trung tâm xem xét. Chúng tôi sẽ gửi email xác nhận trong thời gian sớm nhất (thường trong vòng 2-4 giờ).
        </p>
      </div>
      
      <div class="info-box">
        <h3 style="margin-top: 0; color: #3b82f6;">📋 Thông tin lịch hẹn</h3>
        <div class="info-row">
          <span class="label">Bé:</span>
          <span class="value">${childName}</span>
        </div>
        <div class="info-row">
          <span class="label">Vắc-xin:</span>
          <span class="value">${vaccineName}</span>
        </div>
        <div class="info-row">
          <span class="label">Ngày tiêm:</span>
          <span class="value">${new Date(slotDate).toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
        </div>
        <div class="info-row">
          <span class="label">Giờ:</span>
          <span class="value">${slotTime}</span>
        </div>
        <div class="info-row">
          <span class="label">Địa điểm:</span>
          <span class="value">${centerName}</span>
        </div>
        <div class="info-row">
          <span class="label">Địa chỉ:</span>
          <span class="value">${centerAddress}</span>
        </div>
        <div class="info-row">
          <span class="label">Hotline:</span>
          <span class="value">${centerPhone}</span>
        </div>
      </div>
      
      <p style="margin-top: 30px; color: #6b7280;">
        Nếu cần hỗ trợ, vui lòng liên hệ:<br>
        📞 Hotline: <strong>${centerPhone}</strong><br>
        ✉️ Email: <strong>support@tvnadrenaline.com</strong>
      </p>
    </div>
    
    <div class="footer">
      <p>Email này được gửi tự động, vui lòng không trả lời.</p>
      <p>&copy; 2025 TVNAdrenaline. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
    `;
  }

  /**
   * ✅ Template 2: Staff xác nhận lịch hẹn
   */
  getBookingConfirmationHTML(data) {
    const { bookingCode, childName, vaccineName, slotDate, slotTime, centerName, centerAddress, centerPhone, parentName } = data;
    
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #10b981 0%, #14b8a6 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
    .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
    .info-box { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; border-left: 4px solid #10b981; }
    .info-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
    .info-row:last-child { border-bottom: none; }
    .label { font-weight: bold; color: #6b7280; }
    .value { color: #111827; font-weight: 600; }
    .cta-button { display: inline-block; background: #10b981; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; margin: 20px 0; font-weight: bold; }
    .warning { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 8px; }
    .confirmed-badge { background: #d1fae5; border: 2px solid #10b981; padding: 15px; margin: 20px 0; border-radius: 8px; text-align: center; }
    .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0; font-size: 28px;">✅ Lịch hẹn đã được xác nhận!</h1>
      <p style="margin: 10px 0 0 0; font-size: 16px;">Mã đặt lịch: <strong>${bookingCode}</strong></p>
    </div>
    
    <div class="content">
      <p>Kính chào <strong>${parentName}</strong>,</p>
      
      <div class="confirmed-badge">
        <h2 style="color: #10b981; margin: 0; font-size: 24px;">🎉 XÁC NHẬN THÀNH CÔNG</h2>
        <p style="margin: 10px 0 0 0; font-size: 16px; color: #059669;">
          Trung tâm đã xác nhận lịch tiêm cho bé <strong>${childName}</strong>
        </p>
      </div>
      
      <p>Lịch tiêm chủng của bé đã được <strong>trung tâm xác nhận</strong>. Vui lòng đến đúng giờ để được phục vụ tốt nhất!</p>
      
      <div class="info-box">
        <h3 style="margin-top: 0; color: #10b981;">📋 Thông tin lịch hẹn</h3>
        <div class="info-row">
          <span class="label">Bé:</span>
          <span class="value">${childName}</span>
        </div>
        <div class="info-row">
          <span class="label">Vắc-xin:</span>
          <span class="value">${vaccineName}</span>
        </div>
        <div class="info-row">
          <span class="label">Ngày tiêm:</span>
          <span class="value">${new Date(slotDate).toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
        </div>
        <div class="info-row">
          <span class="label">Giờ:</span>
          <span class="value">${slotTime}</span>
        </div>
        <div class="info-row">
          <span class="label">Địa điểm:</span>
          <span class="value">${centerName}</span>
        </div>
        <div class="info-row">
          <span class="label">Địa chỉ:</span>
          <span class="value">${centerAddress}</span>
        </div>
        <div class="info-row">
          <span class="label">Hotline:</span>
          <span class="value">${centerPhone}</span>
        </div>
      </div>
      
      <div class="warning">
        <strong>⚠️ Lưu ý quan trọng:</strong>
        <ul style="margin: 10px 0 0 0; padding-left: 20px;">
          <li>Vui lòng đến <strong>trước 15 phút</strong> để làm thủ tục</li>
          <li>Mang theo <strong>sổ tiêm chủng</strong> và <strong>CMND/CCCD</strong></li>
          <li>Bé phải <strong>khỏe mạnh</strong>, không sốt</li>
          <li>Có thể xuất trình <strong>QR code</strong> để check-in nhanh hơn</li>
        </ul>
      </div>
      
      <div style="text-align: center;">
        <a href="${process.env.FRONTEND_URL || 'http://localhost:3001'}/my-bookings" class="cta-button">
          Xem QR Code & Chi tiết
        </a>
      </div>
      
      <p style="margin-top: 30px; color: #6b7280;">
        Nếu cần hỗ trợ, vui lòng liên hệ:<br>
        📞 Hotline: <strong>${centerPhone}</strong><br>
        ✉️ Email: <strong>support@tvnadrenaline.com</strong>
      </p>
    </div>
    
    <div class="footer">
      <p>Email này được gửi tự động, vui lòng không trả lời.</p>
      <p>&copy; 2025 TVNAdrenaline. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
    `;
  }

  /**
   * Template: Nhắc lịch trước 1 ngày
   */
  getReminderHTML(data) {
    const { childName, vaccineName, slotDate, slotTime, centerName, centerAddress, parentName } = data;
    
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #f59e0b 0%, #f97316 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
    .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
    .reminder-box { background: #fef3c7; padding: 20px; margin: 20px 0; border-radius: 8px; border: 2px solid #f59e0b; text-align: center; }
    .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0; font-size: 28px;">⏰ Nhắc lịch tiêm</h1>
      <p style="margin: 10px 0 0 0;">Lịch hẹn của bé sắp đến rồi!</p>
    </div>
    
    <div class="content">
      <p>Kính chào <strong>${parentName}</strong>,</p>
      <p>Đây là email nhắc lịch tiêm chủng cho bé <strong>${childName}</strong>.</p>
      
      <div class="reminder-box">
        <h2 style="color: #f59e0b; margin: 0 0 15px 0;">📅 NGÀY MAI</h2>
        <p style="font-size: 18px; margin: 10px 0;"><strong>${new Date(slotDate).toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</strong></p>
        <p style="font-size: 24px; font-weight: bold; color: #14b8a6; margin: 10px 0;">${slotTime}</p>
        <p style="margin: 5px 0;">💉 ${vaccineName}</p>
        <p style="margin: 5px 0;">📍 ${centerName}</p>
      </div>
      
      <p><strong>Chuẩn bị:</strong></p>
      <ul>
        <li>✅ Sổ tiêm chủng</li>
        <li>✅ CMND/CCCD</li>
        <li>✅ Đảm bảo bé khỏe mạnh</li>
        <li>✅ Đến trước 15 phút</li>
      </ul>
      
      <p style="margin-top: 20px; color: #6b7280;">
        📍 Địa chỉ: ${centerAddress}<br>
        📞 Hotline: Liên hệ trung tâm nếu cần đổi lịch
      </p>
    </div>
    
    <div class="footer">
      <p>&copy; 2025 TVNAdrenaline</p>
    </div>
  </div>
</body>
</html>
    `;
  }

  async sendPaymentSuccess(to, data) {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #0d9488, #14b8a6); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
        .info-box { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; border-left: 4px solid #0d9488; }
        .highlight { color: #0d9488; font-weight: bold; font-size: 18px; }
        .status-badge { display: inline-block; background: #dbeafe; color: #1e40af; padding: 8px 16px; border-radius: 20px; font-weight: bold; margin: 10px 0; }
        .button { display: inline-block; background: #0d9488; color: white; padding: 12px 30px; text-decoration: none; border-radius: 8px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>💳 Thanh Toán Thành Công!</h1>
        </div>
        <div class="content">
          <p>Xin chào <strong>${data.parentName}</strong>,</p>
          
          <p>Chúc mừng! Thanh toán của bạn đã được xử lý thành công.</p>
          
          <div class="info-box">
            <p><strong>Mã lịch hẹn:</strong> <span class="highlight">${data.bookingCode}</span></p>
            <p><strong>Tên bé:</strong> ${data.childName}</p>
            <p><strong>Vắc-xin:</strong> ${data.vaccineName}</p>
            <p><strong>Ngày tiêm:</strong> ${this.formatDate(data.slotDate)} - ${data.slotTime}</p>
            <p><strong>Địa điểm:</strong> ${data.centerName}</p>
            <p style="color: #6b7280; font-size: 14px;">${data.centerAddress}</p>
          </div>
          
          <div class="status-badge">🔵 Chờ trung tâm xác nhận</div>
          
          <p><strong>Bước tiếp theo:</strong></p>
          <ul>
            <li>Trung tâm sẽ xác nhận lịch hẹn của bạn trong vòng <strong>2-4 giờ</strong></li>
            <li>Bạn sẽ nhận được email xác nhận khi lịch được duyệt</li>
            <li>Mã QR check-in đã sẵn sàng trong tài khoản của bạn</li>
          </ul>
          
          <a href="http://localhost:3001/my-bookings" class="button">Xem Lịch Của Tôi</a>
          
          <p style="color: #6b7280; font-size: 14px; margin-top: 30px;">
            Nếu có thắc mắc, vui lòng liên hệ: <br>
            📞 Hotline: 1900 9999 <br>
            📧 Email: support@tvnadrenaline.vn
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  return this.sendEmail(to, '💳 Thanh toán thành công - TVNAdrenaline', html);
}

  /**
   * Template: Quên mật khẩu - Gửi OTP
   */
  getResetPasswordHTML(data) {
    const { name, otp, expiresIn } = data;
    
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
    .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
    .otp-box { background: white; padding: 30px; margin: 20px 0; border-radius: 8px; text-align: center; border: 3px dashed #3b82f6; }
    .otp-code { font-size: 48px; font-weight: bold; color: #3b82f6; letter-spacing: 10px; margin: 20px 0; font-family: 'Courier New', monospace; }
    .warning { background: #fee2e2; border-left: 4px solid #ef4444; padding: 15px; margin: 20px 0; border-radius: 8px; }
    .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0; font-size: 28px;">🔐 Đặt lại mật khẩu</h1>
    </div>
    
    <div class="content">
      <p>Xin chào <strong>${name}</strong>,</p>
      <p>Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn.</p>
      
      <div class="otp-box">
        <p style="margin: 0 0 10px 0; color: #6b7280;">Mã xác thực của bạn:</p>
        <div class="otp-code">${otp}</div>
        <p style="margin: 10px 0 0 0; color: #6b7280; font-size: 14px;">
          Mã có hiệu lực trong <strong>${expiresIn} phút</strong>
        </p>
      </div>
      
      <div class="warning">
        <strong>⚠️ Bảo mật:</strong>
        <ul style="margin: 10px 0 0 0; padding-left: 20px;">
          <li><strong>KHÔNG</strong> chia sẻ mã này với bất kỳ ai</li>
          <li>TVNAdrenaline <strong>KHÔNG BAO GIỜ</strong> yêu cầu mã OTP qua điện thoại</li>
          <li>Nếu bạn không yêu cầu, vui lòng bỏ qua email này</li>
        </ul>
      </div>
      
      <p style="margin-top: 20px; color: #6b7280;">
        Nếu bạn gặp vấn đề, liên hệ:<br>
        📞 Hotline: 1900 8198<br>
        ✉️ Email: support@tvnadrenaline.com
      </p>
    </div>
    
    <div class="footer">
      <p>Email này được gửi tự động, vui lòng không trả lời.</p>
      <p>&copy; 2025 TVNAdrenaline</p>
    </div>
  </div>
</body>
</html>
    `;
  }

  /**
   * Template: Thanh toán thành công
   */
  getPaymentSuccessHTML(data) {
    const { bookingCode, childName, vaccineName, amount, paymentMethod, transactionId, parentName } = data;
    
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #10b981 0%, #14b8a6 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
    .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
    .success-icon { font-size: 64px; margin: 20px 0; }
    .info-box { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; }
    .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="success-icon">✅</div>
      <h1 style="margin: 0; font-size: 28px;">Thanh toán thành công!</h1>
    </div>
    
    <div class="content">
      <p>Kính chào <strong>${parentName}</strong>,</p>
      <p>Thanh toán cho lịch tiêm của bé <strong>${childName}</strong> đã được xác nhận thành công.</p>
      
      <div class="info-box">
        <h3 style="color: #10b981; margin-top: 0;">💳 Thông tin thanh toán</h3>
        <p><strong>Mã đặt lịch:</strong> ${bookingCode}</p>
        <p><strong>Vắc-xin:</strong> ${vaccineName}</p>
        <p><strong>Số tiền:</strong> <span style="color: #10b981; font-size: 20px; font-weight: bold;">${Number(amount).toLocaleString()}đ</span></p>
        <p><strong>Phương thức:</strong> ${paymentMethod.toUpperCase()}</p>
        <p><strong>Mã giao dịch:</strong> ${transactionId}</p>
      </div>
      
      <p style="margin-top: 20px;">
        Hóa đơn điện tử đã được lưu vào tài khoản của bạn. 
        Bạn có thể xem và tải xuống bất kỳ lúc nào.
      </p>
    </div>
    
    <div class="footer">
      <p>&copy; 2025 TVNAdrenaline</p>
    </div>
  </div>
</body>
</html>
    `;
  }

  /**
   * Template: Hủy lịch
   */
  getCancellationHTML(data) {
    const { bookingCode, childName, slotDate, slotTime, parentName, reason } = data;
    
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #ef4444 0%, #f97316 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
    .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
    .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0; font-size: 28px;">❌ Lịch hẹn đã bị hủy</h1>
    </div>
    
    <div class="content">
      <p>Kính chào <strong>${parentName}</strong>,</p>
      <p>Lịch tiêm cho bé <strong>${childName}</strong> đã được hủy thành công.</p>
      
      <div style="background: white; padding: 20px; margin: 20px 0; border-radius: 8px;">
        <p><strong>Mã đặt lịch:</strong> ${bookingCode}</p>
        <p><strong>Ngày đã đặt:</strong> ${new Date(slotDate).toLocaleDateString('vi-VN')} - ${slotTime}</p>
        ${reason ? `<p><strong>Lý do:</strong> ${reason}</p>` : ''}
      </div>
      
      <p>Bạn có thể đặt lịch mới bất kỳ lúc nào trên website của chúng tôi.</p>
    </div>
    
    <div class="footer">
      <p>&copy; 2025 TVNAdrenaline</p>
    </div>
  </div>
</body>
</html>
    `;
  }

  // ==================== SEND EMAIL METHODS ====================

  /**
   * ✅ GỬI EMAIL KHI ĐẶT LỊCH LẦN ĐẦU (chưa xác nhận)
   */
  async sendBookingCreated(to, data) {
    try {
      const mailOptions = {
        from: this.from,
        to,
        subject: `📝 Đặt lịch thành công (Chờ xác nhận) - Mã ${data.bookingCode}`,
        html: this.getBookingCreatedHTML(data)
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log(`✅ Email đặt lịch (chờ xác nhận) đã gửi đến ${to}: ${info.messageId}`);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Lỗi gửi email đặt lịch:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * ✅ GỬI EMAIL KHI STAFF XÁC NHẬN
   */
  async sendBookingConfirmation(to, data) {
    try {
      const mailOptions = {
        from: this.from,
        to,
        subject: `✅ Lịch hẹn đã được xác nhận - Mã ${data.bookingCode}`,
        html: this.getBookingConfirmationHTML(data)
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log(`✅ Email xác nhận lịch hẹn đã gửi đến ${to}: ${info.messageId}`);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Lỗi gửi email xác nhận:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Gửi email nhắc lịch
   */
  async sendReminder(to, data) {
    try {
      const mailOptions = {
        from: this.from,
        to,
        subject: `⏰ Nhắc lịch: Tiêm ${data.vaccineName} cho bé ${data.childName} vào ngày mai`,
        html: this.getReminderHTML(data)
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log(`✅ Email nhắc lịch đã gửi đến ${to}: ${info.messageId}`);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Lỗi gửi email nhắc lịch:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Gửi OTP reset password
   */
  async sendResetPasswordOTP(to, data) {
    try {
      const mailOptions = {
        from: this.from,
        to,
        subject: `Mã xác thực đặt lại mật khẩu - ${data.otp}`,
        html: this.getResetPasswordHTML(data)
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log(`Email OTP đã gửi đến ${to}: ${info.messageId}`);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('Lỗi gửi email OTP:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Gửi email thanh toán thành công
   */
  async sendPaymentSuccess(to, data) {
    try {
      const mailOptions = {
        from: this.from,
        to,
        subject: `✅ Thanh toán thành công - ${data.bookingCode}`,
        html: this.getPaymentSuccessHTML(data)
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log(`✅ Email thanh toán đã gửi đến ${to}: ${info.messageId}`);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Lỗi gửi email thanh toán:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Gửi email hủy lịch
   */
  async sendCancellation(to, data) {
    try {
      const mailOptions = {
        from: this.from,
        to,
        subject: `❌ Lịch hẹn ${data.bookingCode} đã bị hủy`,
        html: this.getCancellationHTML(data)
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log(`✅ Email hủy lịch đã gửi đến ${to}: ${info.messageId}`);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Lỗi gửi email hủy lịch:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Gửi email tùy chỉnh
   */
  async sendCustomEmail(to, subject, html) {
    try {
      const mailOptions = {
        from: this.from,
        to,
        subject,
        html
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log(`✅ Email custom đã gửi đến ${to}: ${info.messageId}`);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Lỗi gửi email custom:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new EmailService();
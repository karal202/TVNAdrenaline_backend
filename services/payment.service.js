// services/payment.service.js - Xử lý thanh toán MoMo, VNPay (SỬ DỤNG .ENV)
const crypto = require('crypto');
const axios = require('axios');
const moment = require('moment');
require('dotenv').config(); // ⭐ LOAD .ENV

class PaymentService {
  constructor() {
    // ⭐ MoMo Configuration - ĐỌC TỪ .ENV
    this.momo = {
      partnerCode: process.env.MOMO_PARTNER_CODE,
      accessKey: process.env.MOMO_ACCESS_KEY,
      secretKey: process.env.MOMO_SECRET_KEY,
      endpoint: process.env.MOMO_ENDPOINT,
      redirectUrl: process.env.MOMO_REDIRECT_URL,
      ipnUrl: process.env.MOMO_IPN_URL,
    };

    // ⭐ VNPay Configuration - ĐỌC TỪ .ENV
    this.vnpay = {
      tmnCode: process.env.VNPAY_TMN_CODE,
      hashSecret: process.env.VNPAY_HASH_SECRET,
      url: process.env.VNPAY_URL,
      returnUrl: process.env.VNPAY_RETURN_URL,
      ipnUrl: process.env.VNPAY_IPN_URL,
    };

    // ⭐ VALIDATE: Kiểm tra các biến môi trường bắt buộc
    this.validateConfig();
  }

  validateConfig() {
    const required = {
      momo: ['partnerCode', 'accessKey', 'secretKey', 'endpoint', 'redirectUrl', 'ipnUrl'],
      vnpay: ['tmnCode', 'hashSecret', 'url', 'returnUrl', 'ipnUrl'],
    };

    const missing = [];

    // Check MoMo
    required.momo.forEach(key => {
      if (!this.momo[key]) {
        missing.push(`MOMO_${key.toUpperCase()}`);
      }
    });

    // Check VNPay
    required.vnpay.forEach(key => {
      if (!this.vnpay[key]) {
        missing.push(`VNPAY_${key.toUpperCase()}`);
      }
    });


    if (missing.length > 0) {
      console.warn(`⚠️ Thiếu các biến môi trường: ${missing.join(', ')}`);
      console.warn('⚠️ Vui lòng cập nhật file .env');
    } else {
      console.log('✅ Payment config loaded successfully');
    }
  }

  // ==================== MOMO (ATM CARD) ====================
  
  async createMoMoPayment(data) {
    const { orderId, amount, orderInfo, bookingId } = data;
    
    const requestId = `${orderId}_${Date.now()}`;
    const extraData = bookingId ? Buffer.from(JSON.stringify({ bookingId })).toString('base64') : '';
    
    const requestType = 'payWithATM';
    
    const rawSignature = `accessKey=${this.momo.accessKey}&amount=${amount}&extraData=${extraData}&ipnUrl=${this.momo.ipnUrl}&orderId=${orderId}&orderInfo=${orderInfo}&partnerCode=${this.momo.partnerCode}&redirectUrl=${this.momo.redirectUrl}&requestId=${requestId}&requestType=${requestType}`;
    
    const signature = crypto
      .createHmac('sha256', this.momo.secretKey)
      .update(rawSignature)
      .digest('hex');

    const requestBody = {
      partnerCode: this.momo.partnerCode,
      accessKey: this.momo.accessKey,
      requestId,
      amount,
      orderId,
      orderInfo,
      redirectUrl: this.momo.redirectUrl,
      ipnUrl: this.momo.ipnUrl,
      extraData,
      requestType, // ← payWithATM
      signature,
      lang: 'vi',
    };

    try {
      const response = await axios.post(this.momo.endpoint, requestBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });

      if (response.data.resultCode === 0) {
        return {
          success: true,
          payUrl: response.data.payUrl,
          qrCodeUrl: response.data.qrCodeUrl,
          deeplink: response.data.deeplink,
          orderId,
          requestId
        };
      }

      throw new Error(response.data.message || 'MoMo payment failed');
    } catch (error) {
      console.error('MoMo Payment Error:', error.response?.data || error.message);
      throw new Error('Không thể tạo thanh toán MoMo');
    }
  }

  verifyMoMoSignature(data) {
    const {
      partnerCode, orderId, requestId, amount, orderInfo,
      orderType, transId, resultCode, message, payType,
      responseTime, extraData, signature
    } = data;

    const rawSignature = `accessKey=${this.momo.accessKey}&amount=${amount}&extraData=${extraData}&message=${message}&orderId=${orderId}&orderInfo=${orderInfo}&orderType=${orderType}&partnerCode=${partnerCode}&payType=${payType}&requestId=${requestId}&responseTime=${responseTime}&resultCode=${resultCode}&transId=${transId}`;

    const expectedSignature = crypto
      .createHmac('sha256', this.momo.secretKey)
      .update(rawSignature)
      .digest('hex');

    return signature === expectedSignature;
  }

  // ==================== VNPAY ====================

  createVNPayPayment(data) {
    const { orderId, amount, orderInfo, ipAddr, bookingId } = data;
    
    const date = new Date();
    const createDate = moment(date).format('YYYYMMDDHHmmss');
    const expireDate = moment(date).add(15, 'minutes').format('YYYYMMDDHHmmss');

    let vnpParams = {
      vnp_Version: '2.1.0',
      vnp_Command: 'pay',
      vnp_TmnCode: this.vnpay.tmnCode,
      vnp_Locale: 'vn',
      vnp_CurrCode: 'VND',
      vnp_TxnRef: orderId,
      vnp_OrderInfo: orderInfo,
      vnp_OrderType: 'other',
      vnp_Amount: amount * 100,
      vnp_ReturnUrl: this.vnpay.returnUrl,
      vnp_IpAddr: ipAddr,
      vnp_CreateDate: createDate,
      vnp_ExpireDate: expireDate,
    };

    if (bookingId) {
      vnpParams.vnp_OrderInfo = `${orderInfo} - BookingID: ${bookingId}`;
    }

    vnpParams = this.sortObject(vnpParams);

    const signData = new URLSearchParams(vnpParams).toString();
    const hmac = crypto.createHmac('sha512', this.vnpay.hashSecret);
    const signed = hmac.update(Buffer.from(signData, 'utf-8')).digest('hex');
    
    vnpParams.vnp_SecureHash = signed;

    const paymentUrl = this.vnpay.url + '?' + new URLSearchParams(vnpParams).toString();
    
    return {
      success: true,
      payUrl: paymentUrl,
      orderId,
      createDate
    };
  }

  verifyVNPaySignature(vnpParams) {
    const secureHash = vnpParams.vnp_SecureHash;
    delete vnpParams.vnp_SecureHash;
    delete vnpParams.vnp_SecureHashType;

    const sortedParams = this.sortObject(vnpParams);
    const signData = new URLSearchParams(sortedParams).toString();
    
    const hmac = crypto.createHmac('sha512', this.vnpay.hashSecret);
    const signed = hmac.update(Buffer.from(signData, 'utf-8')).digest('hex');

    return secureHash === signed;
  }

  // ==================== HELPERS ====================

  sortObject(obj) {
    const sorted = {};
    const keys = Object.keys(obj).sort();
    keys.forEach(key => {
      sorted[key] = obj[key];
    });
    return sorted;
  }

  generateOrderId(prefix = 'TVN') {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  }

  parseExtraData(extraData) {
    try {
      if (!extraData) return {};
      return JSON.parse(Buffer.from(extraData, 'base64').toString('utf-8'));
    } catch {
      return {};
    }
  }
}

module.exports = new PaymentService();
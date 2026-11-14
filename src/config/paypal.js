const { HttpError } = require('../utils/errors');

function createPayPal(env = process.env, request = fetch) {
  if (!env.PAYPAL_CLIENT_ID && !env.PAYPAL_CLIENT_SECRET) return null;
  const required = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_MERCHANT_ID',
    'PUBLIC_API_URL', 'PAYPAL_SUCCESS_URL', 'PAYPAL_CANCEL_URL'];
  for (const key of required) if (!env[key]) throw new Error(key + ' is required for PayPal');
  if (!['sandbox', 'live'].includes(env.PAYPAL_MODE ?? 'sandbox')) throw new Error('Invalid PAYPAL_MODE');
  const live = env.PAYPAL_MODE === 'live';
  const base = live ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const approvalHost = live ? 'www.paypal.com' : 'www.sandbox.paypal.com';
  const publicUrl = name => {
    const url = new URL(env[name]);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error(name + ' must use HTTPS');
    return url;
  };
  const apiUrl = publicUrl('PUBLIC_API_URL');
  const successUrl = publicUrl('PAYPAL_SUCCESS_URL').href;
  const cancelUrl = publicUrl('PAYPAL_CANCEL_URL').href;
  const basic = Buffer.from(env.PAYPAL_CLIENT_ID + ':' + env.PAYPAL_CLIENT_SECRET).toString('base64');
  let cached;
  async function accessToken() {
    if (cached && cached.until > Date.now()) return cached.token;
    const response = await request(base + '/v1/oauth2/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!response.ok) throw new HttpError(502, 'PayPal authentication failed');
    const data = await response.json();
    if (typeof data.access_token !== 'string') throw new HttpError(502, 'Invalid PayPal response');
    cached = { token: data.access_token, until: Date.now() + Math.max(0, Number(data.expires_in) - 60) * 1000 };
    return cached.token;
  }
  async function call(path, method, body, requestId) {
    const response = await request(base + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: {
        Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/json',
        ...(requestId && { 'PayPal-Request-Id': requestId }),
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new HttpError(502, 'PayPal request failed');
    return response.json();
  }
  return {
    merchantId: env.PAYPAL_MERCHANT_ID,
    successUrl,
    async create(order) {
      const route = order.purpose === 'balance' ? 'paybalance' : 'pay';
      const data = await call('/v2/checkout/orders', 'POST', {
        intent: 'CAPTURE',
        purchase_units: [{
          custom_id: order.id,
          amount: { currency_code: order.currency, value: order.amount },
        }],
        payment_source: { paypal: { experience_context: {
          return_url: new URL('/reseller/' + route + '/paypal/success', apiUrl).href,
          cancel_url: cancelUrl, user_action: 'PAY_NOW',
        } } },
      }, order.id);
      const link = data.links?.find(item => item.rel === 'payer-action' || item.rel === 'approve')?.href;
      const approval = new URL(link ?? 'https://invalid.example');
      if (!/^[A-Z0-9]{6,64}$/.test(data.id ?? '') || approval.protocol !== 'https:' ||
          approval.hostname !== approvalHost || approval.username || approval.password) {
        throw new HttpError(502, 'Invalid PayPal order response');
      }
      return { id: data.id, redirectUrl: approval.href };
    },
    read: orderId => call('/v2/checkout/orders/' + encodeURIComponent(orderId), 'GET'),
    capture: (orderId, key) => call('/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', 'POST', {}, key),
  };
}
module.exports = { createPayPal };

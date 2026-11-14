const { createHash, createSign } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { HttpError } = require('../utils/errors');

const oauthUrl = 'https://oauth2.googleapis.com/token';
const publisherUrl = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function createGooglePlay(env = process.env, request = fetch) {
  const product = env.GOOGLE_PLAY_PRODUCT_ID;
  const basePlan = env.GOOGLE_PLAY_BASE_PLAN_ID;
  const keyFile = env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE;
  if (!product || !basePlan || !keyFile) return null;
  const key = JSON.parse(readFileSync(keyFile, 'utf8'));
  const packageName = env.GOOGLE_PLAY_PACKAGE_NAME || 'com.velotv.player';
  const api = publisherUrl + encodeURIComponent(packageName);
  let credentials;
  let refreshing;

  async function accessToken() {
    if (credentials && credentials.expiresAt > Date.now()) return credentials.token;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const iat = Math.floor(Date.now() / 1000);
      const data = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({
        iss: key.client_email, aud: oauthUrl, iat, exp: iat + 3600,
        scope: 'https://www.googleapis.com/auth/androidpublisher',
      });
      const signature = createSign('RSA-SHA256').update(data).sign(key.private_key, 'base64url');
      const response = await request(oauthUrl, {
        method: 'POST', signal: AbortSignal.timeout(8000),
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: data + '.' + signature,
        }),
      });
      if (!response.ok) throw new HttpError(502, 'Google Play authorization failed');
      const result = await response.json();
      credentials = { token: result.access_token, expiresAt: Date.now() + (result.expires_in - 60) * 1000 };
      return credentials.token;
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }

  async function call(path, method = 'GET') {
    const headers = { Authorization: 'Bearer ' + await accessToken() };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    return request(api + path, {
      method, headers, signal: AbortSignal.timeout(8000), ...(method === 'POST' && { body: '{}' }),
    });
  }

  const verify = async (androidId, purchaseToken) => {
    try {
      const token = encodeURIComponent(purchaseToken);
      const response = await call('/purchases/subscriptionsv2/tokens/' + token);
      if (response.status === 400 || response.status === 404 || response.status === 410) return null;
      if (!response.ok) throw new HttpError(502, 'Google Play verification failed');
      const purchase = await response.json();
      const expectedAccount = createHash('sha256').update('velotv-device:' + androidId).digest('hex');
      if (purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId !== expectedAccount) return null;

      const validStates = new Set(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
        'SUBSCRIPTION_STATE_CANCELED']);
      if (!validStates.has(purchase.subscriptionState)) return null;
      const item = (purchase.lineItems ?? []).filter(line =>
        line.productId === product && line.offerDetails?.basePlanId === basePlan &&
        Date.parse(line.expiryTime) > Date.now()
      ).sort((a, b) => Date.parse(b.expiryTime) - Date.parse(a.expiryTime))[0];
      if (!item) return null;
      if (purchase.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
        const acknowledged = await call('/purchases/subscriptions/' + encodeURIComponent(product) +
          '/tokens/' + token + ':acknowledge', 'POST');
        if (!acknowledged.ok) throw new HttpError(502, 'Google Play acknowledgement failed');
      } else if (purchase.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') {
        return null;
      }
      return {
        source: 'google_play', plan: 'monthly', productId: product,
        status: purchase.subscriptionState === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' ? 'grace_period' : 'active',
        expiresAt: Date.parse(item.expiryTime), verifiedAt: Date.now(),
        autoRenewing: item.autoRenewingPlan?.autoRenewEnabled === true,
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'Google Play is temporarily unavailable');
    }
  };
  return Object.assign(verify, { product, basePlan });
}

module.exports = { createGooglePlay };

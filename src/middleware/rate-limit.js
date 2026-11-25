const { isIP } = require('node:net');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

function getClientIp(req) {
  // Railway's public HTTP edge supplies X-Real-IP for the original client.
  // Use it instead of trusting an arbitrary X-Forwarded-For chain.
  const railwayClientIp = req.get('X-Real-IP')?.trim();
  if (railwayClientIp && isIP(railwayClientIp)) return railwayClientIp;
  return req.ip;
}

function createRateLimit(options) {
  return rateLimit({
    ...options,
    keyGenerator: req => ipKeyGenerator(getClientIp(req)),
  });
}

module.exports = { createRateLimit };

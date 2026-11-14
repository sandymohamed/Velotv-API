const jwt = require('jsonwebtoken');
const accounts = require('../models/account-model');
const { HttpError } = require('../utils/errors');

function authenticate(pool, key, roles) {
  return async (req, _res, next) => {
    let claims;
    try {
      const token = req.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
      claims = jwt.verify(token, key, { algorithms: ['HS256'], issuer: 'velotv-api', audience: 'velotv-staff' });
    } catch { throw new HttpError(401, 'Authentication required'); }
    if (!roles.includes(claims.role) || !Number.isSafeInteger(claims.id)) {
      throw new HttpError(403, 'Permission denied');
    }
    if (!(await accounts.activeAccount(pool, claims.role, claims.id))) {
      throw new HttpError(403, 'Account disabled or missing');
    }
    req.user = claims;
    next();
  };
}
module.exports = { authenticate };

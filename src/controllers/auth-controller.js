const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const accounts = require('../models/account-model');
const { HttpError } = require('../utils/errors');

const input = z.object({
  email: z.string().trim().max(255).optional(),
  username: z.string().trim().max(255).optional(),
  password: z.string().min(1).max(72),
});
const dummyHash = bcrypt.hashSync('invalid-account-fallback', 12);

function login(pool, key, role) {
  return async (req, res) => {
    const { email, username, password } = input.parse(req.body);
    const identifier = role === 'admin' ? email : (email || username);
    if (!identifier) throw new HttpError(400, 'Missing login identifier');
    const account = await accounts.findLogin(pool, role, identifier);
    const valid = await bcrypt.compare(password, account?.password || dummyHash);
    if (!valid || account?.status !== 1) {
      return res.status(202).json({ success: false, result: 'Incorrect credentials' });
    }
    const { password: _secret, ...payload } = account;
    payload.role = role;
    const result = jwt.sign({ id: account.id, role }, key, {
      algorithm: 'HS256', expiresIn: '1h', issuer: 'velotv-api', audience: 'velotv-staff',
    });
    res.json({ success: true, result, payload });
  };
}
module.exports = { login };

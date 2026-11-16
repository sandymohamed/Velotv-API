const { activeReseller } = require('../services/reseller-access');
const accounts = {
  admin: {
    login: 'SELECT id, name, email, password, status FROM admins WHERE email = ? LIMIT 2',
    status: 'SELECT id FROM admins WHERE id = ? AND status = 1',
  },
  reseller: {
    login: 'SELECT id, username, email, phone, password, status FROM resellers WHERE (email = ? OR username = ?) LIMIT 2',
    status: 'SELECT id FROM resellers WHERE id = ? AND status = 1',
  },
};

async function findLogin(db, role, name) {
  const [rows] = await db.execute(accounts[role].login, role === 'reseller' ? [name, name] : [name]);
  return rows.length === 1 ? rows[0] : null;
}

async function activeAccount(db, role, id) {
  if (role === 'reseller') return activeReseller(db, id);
  const [[account]] = await db.execute(accounts[role].status, [id]);
  return account;
}

module.exports = { findLogin, activeAccount };

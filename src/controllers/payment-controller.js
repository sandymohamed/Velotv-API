const { z } = require('zod');
const { id, money } = require('../utils/validation');
const { createPayment, confirmPayment } = require('../services/paypal-service');

function paymentController(pool, paypal, purpose) {
  const input = purpose === 'package' ? z.object({ package_id: id }) : z.object({ amount: money });
  return {
    async create(req, res) {
      res.json(await createPayment(pool, paypal, req.user.id, purpose, input.parse(req.body)));
    },
    async success(req, res) {
      const token = z.string().regex(/^[A-Z0-9]{6,64}$/).parse(req.query.token);
      await confirmPayment(pool, paypal, purpose, token);
      res.redirect(303, paypal.successUrl);
    },
  };
}
module.exports = { paymentController };

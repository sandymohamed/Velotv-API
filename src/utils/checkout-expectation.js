const { z } = require('zod');
const { id, money } = require('./validation');
const { HttpError } = require('./errors');

const checkoutExpectation = z.object({
  amount: money,
  periods: z.number().int().min(1).max(120),
  count_devices: z.number().int().min(1).max(1000),
  offer_id: id.nullable(),
}).strict();

function assertExpectation(actual, expected) {
  if (expected && (Number(actual.amount) !== Number(expected.amount) ||
      actual.periods !== expected.periods || actual.count_devices !== expected.count_devices ||
      Number(actual.offer_id || 0) !== Number(expected.offer_id || 0))) {
    throw new HttpError(409, 'Package terms changed. Refresh the catalog before purchasing.');
  }
}

module.exports = { checkoutExpectation, assertExpectation };

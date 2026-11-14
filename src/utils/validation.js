const { z } = require('zod');
const id = z.union([z.number().int(), z.string().regex(/^\d{1,10}$/).transform(Number)])
  .pipe(z.number().int().positive().max(2147483647));
const money = z.union([z.string(), z.number().transform(String)]).pipe(
  z.string().regex(/^\d{1,5}(\.\d{1,5})?$/)
    .refine(value => Number(value) > 0)
    .transform(value => Number(value).toFixed(5)),
);
const reference = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const mac = z.string().trim().toLowerCase().regex(/^([a-f0-9]{2}:){5}[a-f0-9]{2}$/)
  .refine(v => !['00:00:00:00:00:00','02:00:00:00:00:00','ff:ff:ff:ff:ff:ff'].includes(v));
const androidId = z.string().trim().toLowerCase().regex(/^[0-9a-f]{1,16}$/)
  .refine(value => !/^0+$/.test(value) && value !== '9774d56d682e549c')
  .transform(value => value.padStart(16, '0'));
module.exports = { id, money, reference, mac, androidId };

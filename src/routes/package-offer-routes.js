const { Router } = require('express');
const { z } = require('zod');
const { authenticate } = require('../middleware/auth');
const { transaction } = require('../config/database');
const { id } = require('../utils/validation');
const { HttpError } = require('../utils/errors');
const { priceUnits } = require('../services/package-offer-service');

const offerInput = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
  offer_amount: z.number().positive().max(99999.99).multipleOf(0.01),
  max_purchases_per_reseller: z.number().int().min(1).max(100000).nullable(),
  audience: z.enum(['all', 'selected']),
  reseller_ids: z.array(id).max(500),
}).strict().superRefine((input, ctx) => {
  if (new Date(input.ends_at) <= new Date(input.starts_at)) {
    ctx.addIssue({ code: 'custom', path: ['ends_at'], message: 'End must be after start' });
  }
  if ((input.audience === 'selected') !== (input.reseller_ids.length > 0)) {
    ctx.addIssue({ code: 'custom', path: ['reseller_ids'], message: 'Selected audience needs reseller IDs, all audience needs an empty array' });
  }
  if (new Set(input.reseller_ids).size !== input.reseller_ids.length) {
    ctx.addIssue({ code: 'custom', path: ['reseller_ids'], message: 'Duplicate reseller IDs' });
  }
});

const utc = value => new Date(value).toISOString().slice(0, 19).replace('T', ' ');

async function lockPackage(db, packageId) {
  const [[pack]] = await db.execute('SELECT id, package_amount, archived_at FROM packages_reseller WHERE id=? FOR UPDATE', [packageId]);
  if (!pack) throw new HttpError(404, 'Package not found');
  if (pack.archived_at) throw new HttpError(409, 'Restore the archived package before changing availability or offers.');
  return pack;
}

async function saveAudience(db, offerId, input) {
  await db.execute('DELETE FROM velotv_package_offer_resellers WHERE offer_id=?', [offerId]);
  if (!input.reseller_ids.length) return;
  const [rows] = await db.execute(`SELECT id FROM resellers WHERE id IN (${input.reseller_ids.map(() => '?').join(',')})`, input.reseller_ids);
  if (rows.length !== input.reseller_ids.length) throw new HttpError(400, 'One or more resellers do not exist');
  for (const resellerId of input.reseller_ids) {
    await db.execute('INSERT INTO velotv_package_offer_resellers(offer_id,reseller_id) VALUES (?,?)', [offerId,resellerId]);
  }
}

async function audit(db, actor, action, target) {
  await db.execute('INSERT INTO velotv_admin_activity(admin_id,action,target_id) VALUES (?,?,?)', [actor,action,target]);
}

function packageOfferRoutes(pool, key) {
  const router = Router();
  router.use('/api/admin/console', authenticate(pool, key, ['admin']));

  router.patch('/api/admin/console/coupon-packages/:id/availability', async (req, res) => {
    const packageId = id.parse(req.params.id);
    const input = z.object({ enabled: z.boolean(), offer_only: z.boolean() }).strict().parse(req.body);
    await transaction(pool, async db => {
      await lockPackage(db, packageId);
      await db.execute('UPDATE packages_reseller SET enabled=?,offer_only=?,updated_at=UTC_TIMESTAMP() WHERE id=?', [input.enabled,input.offer_only,packageId]);
      await audit(db, req.user.id, 'package_availability_updated', packageId);
    });
    res.json({ id: packageId, ...input });
  });

  router.get('/api/admin/console/package-offers', async (req, res) => {
    const packageId = req.query.package_id == null ? null : id.parse(req.query.package_id);
    const [offers] = await pool.execute(`SELECT o.*,p.package_name,p.package_amount AS base_amount,p.archived_at AS package_archived_at,
      o.enabled=1 AND p.enabled=1 AND p.archived_at IS NULL AND o.starts_at<=UTC_TIMESTAMP() AND UTC_TIMESTAMP()<o.ends_at AS in_window
      FROM velotv_package_offers o JOIN packages_reseller p ON p.id=o.package_id
      WHERE (? IS NULL OR o.package_id=?) ORDER BY o.id DESC LIMIT 500`, [packageId,packageId]);
    const [audience] = await pool.execute('SELECT offer_id,reseller_id FROM velotv_package_offer_resellers');
    res.json({ offers: offers.map(offer => ({ ...offer, reseller_ids: audience.filter(row => row.offer_id === offer.id).map(row => row.reseller_id) })) });
  });

  router.post('/api/admin/console/coupon-packages/:id/offers', async (req, res) => {
    const packageId = id.parse(req.params.id);
    const input = offerInput.parse(req.body);
    const offerId = await transaction(pool, async db => {
      const pack = await lockPackage(db, packageId);
      if (priceUnits(input.offer_amount) > priceUnits(pack.package_amount)) throw new HttpError(400, 'Offer price cannot exceed the base price');
      const [insert] = await db.execute(`INSERT INTO velotv_package_offers
        (package_id,name,enabled,starts_at,ends_at,offer_amount,max_purchases_per_reseller,audience)
        VALUES (?,?,?,?,?,?,?,?)`, [packageId,input.name,input.enabled,utc(input.starts_at),utc(input.ends_at),
        input.offer_amount,input.max_purchases_per_reseller,input.audience]);
      await saveAudience(db, insert.insertId, input);
      await audit(db, req.user.id, 'package_offer_created', insert.insertId);
      return insert.insertId;
    });
    res.status(201).json({ id: offerId });
  });

  router.patch('/api/admin/console/package-offers/:id', async (req, res) => {
    const offerId = id.parse(req.params.id);
    const input = offerInput.parse(req.body);
    await transaction(pool, async db => {
      const [[offer]] = await db.execute('SELECT package_id FROM velotv_package_offers WHERE id=?', [offerId]);
      if (!offer) throw new HttpError(404, 'Offer not found');
      const pack = await lockPackage(db, offer.package_id);
      if (priceUnits(input.offer_amount) > priceUnits(pack.package_amount)) throw new HttpError(400, 'Offer price cannot exceed the base price');
      await db.execute(`UPDATE velotv_package_offers SET name=?,enabled=?,starts_at=?,ends_at=?,offer_amount=?,
        max_purchases_per_reseller=?,audience=?,updated_at=UTC_TIMESTAMP() WHERE id=?`, [input.name,input.enabled,
        utc(input.starts_at),utc(input.ends_at),input.offer_amount,input.max_purchases_per_reseller,input.audience,offerId]);
      await saveAudience(db, offerId, input);
      await audit(db, req.user.id, 'package_offer_updated', offerId);
    });
    res.json({ id: offerId });
  });

  const filters = z.object({ reseller_id: id.optional(), package_id: id.optional(),
    page: z.coerce.number().int().min(0).max(10000).default(0) });
  async function purchases(req, res, resellerId) {
    const filter = filters.parse(req.query);
    const args = [resellerId ?? filter.reseller_id ?? null,filter.package_id ?? null];
    const where = 'WHERE (? IS NULL OR reseller_id=?) AND (? IS NULL OR package_id=?)';
    const params = [args[0],args[0],args[1],args[1]];
    const [rows] = await pool.execute(`SELECT * FROM velotv_package_purchases ${where} ORDER BY created_at DESC,id DESC LIMIT 100 OFFSET ?`, [...params,filter.page*100]);
    const [[{ count }]] = await pool.execute(`SELECT COUNT(*) AS count FROM velotv_package_purchases ${where}`, params);
    res.json({ rows, count });
  }
  router.get('/api/admin/console/package-purchases', (req, res) => purchases(req,res));
  router.get('/reseller/dashboard/package-purchases', authenticate(pool,key,['reseller']), (req,res) => purchases(req,res,req.user.id));
  return router;
}

module.exports = { packageOfferRoutes, offerInput };

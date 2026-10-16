import express from 'express';
import { randomUUID } from 'node:crypto';
import { listHoldings, saveHolding, deleteHolding } from './db/index.js';

export const ASSET_CLASSES = ['Stocks','Mutual funds','Bonds','Deposits','Gold','Other'];
const fields = ['name','assetClass','investedPaise','currentPaise','valuedOn'];
/** Holdings are manual, dated valuations in integer paise, not live market quotes.
 * Zero is valid; rejecting extra fields prevents clients from supplying ownership.
 * The router always derives the owner from the authenticated session. */
export function validHolding(body, today = new Date().toISOString().slice(0,10)) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== fields.length || !fields.every(k => Object.hasOwn(body,k))) return false;
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(body.name) || !ASSET_CLASSES.includes(body.assetClass)) return false;
  if (![body.investedPaise,body.currentPaise].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1e12)) return false;
  const d = body.valuedOn;
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= '1900-01-01' && d <= today && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0,10) === d;
}
export function holdingsRouter(authenticate, limiter) {
  const router = express.Router();
  router.use(authenticate, limiter);
  router.get('/', async (req,res,next) => {
    try { res.json(await listHoldings(req.user.id)); } catch(e) { next(e); }
  });
  const validId = (req,res,next) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id) ? next() : res.status(404).json({error:'Holding not found'});
  const save = create => async (req,res,next) => {
    if (!validHolding(req.body)) return res.status(400).json({error:'Enter a name, asset class, nonnegative amounts in whole paise, and a valid valuation date no later than today.'});
    try {
      const h = await saveHolding(req.user.id, create ? randomUUID() : req.params.id, {...req.body,name:req.body.name.trim()},create);
      return h ? res.status(create ? 201 : 200).json(h) : res.status(404).json({error:'Holding not found'});
    } catch(e) { next(e); }
  };
  router.post('/',save(true));
  router.put('/:id',validId,save(false));
  router.delete('/:id',validId,async (req,res,next) => {
    try { return await deleteHolding(req.user.id,req.params.id) ? res.status(204).end() : res.status(404).json({error:'Holding not found'}); } catch(e) { next(e); }
  });
  return router;
}

import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { demoIdentity } from './accountAggregatorDemoData.js';
export { demoOverview } from './accountAggregatorDemoData.js';

export const sandboxEnabled = (env) => env.NODE_ENV === 'development' && env.FINSPHERE_AA_SANDBOX === 'true';

const audience = 'finsphere-aa-sandbox';
const algorithm = 'HS256';
const consentKey = randomBytes(32);

export function grantDemoConsent(body, userId) {
  if (!body || Object.keys(body).length !== 2 || body.identity !== demoIdentity || body.approved !== true) return null;
  return jwt.sign({}, consentKey, { algorithm, audience, subject: String(userId), expiresIn: '10m' });
}

export function hasDemoConsent(token, userId) {
  if (typeof token !== 'string' || token.length > 512) return false;
  try {
    jwt.verify(token, consentKey, { algorithms: [algorithm], audience, subject: String(userId) });
    return true;
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) return false;
    throw error;
  }
}

import { randomBytes, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers';

export const RESET_MESSAGE = 'If an account exists for that email, a password reset link will be sent.';
export const hashResetToken = (token) => createHash('sha256').update(token).digest('hex');
export const validResetToken = (token) => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
export const validResetPassword = (password) => typeof password === 'string' && password.length >= 8 && Buffer.byteLength(password, 'utf8') <= 72;

// The configured, trusted frontend URL a reset link points at. Never derived from a request.
function trustedResetBase(env) {
  const base = new URL(env.PASSWORD_RESET_URL);
  if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)))) {
    throw new Error('PASSWORD_RESET_URL must be a trusted HTTPS frontend URL (localhost HTTP allowed in development)');
  }
  return base;
}

// The one email a user receives (Resend) or a developer captures (local mode): identical text either way.
function buildResetEmail(base, token) {
  const link = new URL(base);
  link.hash = `reset=${token}`;
  return {
    subject: 'Reset your FinSphere password',
    link: String(link),
    text: `Reset your FinSphere password using this link within 15 minutes:\n${link}\n\nIf you did not request this, ignore this email. Your password has not changed.`
  };
}

export function createResetMailer(env, fetchImpl = fetch) {
  if (!env.RESEND_API_KEY || !env.PASSWORD_RESET_FROM || !env.PASSWORD_RESET_URL) return null;
  const base = trustedResetBase(env);
  return async (email, token) => {
    const message = buildResetEmail(base, token);
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.PASSWORD_RESET_FROM, to: [email], subject: message.subject, text: message.text })
    });
    if (!response.ok) throw new Error('Password reset email delivery failed');
  };
}

// ── Development-only local capture (PASSWORD_RESET_DELIVERY=local) ───────────────────────────────────────────────
// For testing Forgot Password without a verified Resend domain. It is an explicit opt-in: nothing selects it implicitly,
// production refuses to start with it, and a missing Resend configuration NEVER falls back to it (the endpoint answers 503
// exactly as before). The captured mail lives in this process's memory only (a few most recent messages): it is never
// written to a log, a file or the database, and the reset link/token is never printed.
export const LOCAL_MAIL_LIMIT = 20;

export function resolveResetDeliveryMode(env) {
  const raw = String(env.PASSWORD_RESET_DELIVERY ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'resend') return 'resend';
  if (raw === 'local') {
    if (env.NODE_ENV === 'production') throw new Error('PASSWORD_RESET_DELIVERY=local is development-only and is not allowed when NODE_ENV=production');
    return 'local';
  }
  throw new Error('PASSWORD_RESET_DELIVERY must be "resend" or "local"');
}

export function createLocalMailCapture({ limit = LOCAL_MAIL_LIMIT, now = () => new Date().toISOString() } = {}) {
  let mails = [];
  return {
    add(mail) { mails.push({ ...mail, capturedAt: now() }); if (mails.length > limit) mails = mails.slice(-limit); },
    // Newest first, optionally only the mail sent to one address.
    list(email) {
      const wanted = typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;
      return mails.filter((m) => !wanted || m.to.toLowerCase() === wanted).reverse();
    },
    clear() { const n = mails.length; mails = []; return n; },
    get size() { return mails.length; }
  };
}

// -> { mode: 'resend' | 'local', sendEmail: fn | null, capture: store | null }
// resend (the default): exactly the Resend mailer, or null (503) when it is not configured. local: records the email in
// memory and calls nothing else.
export function createResetDelivery(env, fetchImpl = fetch) {
  const mode = resolveResetDeliveryMode(env);
  if (mode === 'resend') return { mode, sendEmail: createResetMailer(env, fetchImpl), capture: null };
  const base = trustedResetBase({ ...env, PASSWORD_RESET_URL: env.PASSWORD_RESET_URL || 'http://localhost:5173/' });
  const capture = createLocalMailCapture();
  return {
    mode,
    capture,
    sendEmail: async (email, token) => { capture.add({ to: email, ...buildResetEmail(base, token) }); }
  };
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

// GET / DELETE /api/dev/password-reset-mail (registered only in local mode). Answers 404, as if the route did not exist,
// unless ALL of these hold: NODE_ENV is not production, the TCP peer is the loopback interface (the raw socket address, so
// a spoofed X-Forwarded-For cannot satisfy it), and the Host header is a localhost name (so a DNS-rebinding page cannot
// read it). It exposes only the captured test mail, never configuration, keys or passwords.
export function createDevMailHandlers({ capture, env }) {
  const allowed = (req) => env.NODE_ENV !== 'production'
    && LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress)
    && LOCAL_HOSTNAMES.has(String(req.headers?.host ?? '').replace(/:\d+$/, '').toLowerCase());
  const guard = (handler) => (req, res) => {
    if (!allowed(req)) return res.status(404).json({ error: 'Not found' });
    res.set?.('Cache-Control', 'no-store');
    return handler(req, res);
  };
  return {
    list: guard((req, res) => res.json({ mails: capture.list(req.query?.email) })),
    clear: guard((req, res) => res.json({ cleared: capture.clear() }))
  };
}

export function createPasswordResetHandlers({ issueToken, consumeToken, hashPassword, sendEmail, reportFailure = () => {} }) {
  return {
    forgot(req, res) {
      const email = req.body?.email;
      if (typeof email !== 'string' || email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      if (!sendEmail) return res.status(503).json({ error: 'Password recovery is temporarily unavailable. Please try again later.' });
      // Respond before account lookup or delivery: neither account existence nor provider latency is exposed.
      res.status(202).json({ message: RESET_MESSAGE });
      setImmediate(async () => {
        try {
          const token = randomBytes(32).toString('hex');
          const user = await issueToken(email.trim().toLowerCase(), hashResetToken(token));
          if (user) await sendEmail(user.email, token);
        } catch { reportFailure(); } // Never log emails, links, tokens or provider response bodies.
      });
    },
    async reset(req, res) {
      const { token, password } = req.body ?? {};
      if (!validResetToken(token)) return res.status(400).json({ error: 'Invalid or expired reset link' });
      if (!validResetPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters and no more than 72 UTF-8 bytes' });
      try {
        const passwordHash = await hashPassword(password);
        if (!await consumeToken(hashResetToken(token), passwordHash)) return res.status(400).json({ error: 'Invalid or expired reset link' });
        res.json({ message: 'Password reset successfully. Please log in with your new password.' });
      } catch {
        reportFailure();
        res.status(500).json({ error: 'Could not reset password. Please try again later.' });
      }
    }
  };
}

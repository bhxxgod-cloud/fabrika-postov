import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

// Простой вход одного оператора: общий пароль + подписанная кука сессии (HMAC).
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'np_session';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

if (!PASSWORD) console.warn('[auth] DASHBOARD_PASSWORD не задан — панель заблокирована.');

export function checkPassword(input: string): boolean {
  if (!PASSWORD) return false;
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

export function signSession(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + MAX_AGE_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(value?: string): boolean {
  if (!value) return false;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const s = Buffer.from(sig), e = Buffer.from(expected);
  if (s.length !== e.length || !crypto.timingSafeEqual(s, e)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  (header || '').split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

export const COOKIE_NAME = COOKIE;
export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: Boolean(process.env.RAILWAY_ENVIRONMENT) || process.env.NODE_ENV === 'production',
  maxAge: MAX_AGE_MS,
  path: '/',
};

// Машинный доступ: `Authorization: Bearer <API_TOKEN>`. Нужен, чтобы ДРУГИЕ процессы/чаты могли слать
// сигнал «акки упали — подними» без куки-логина панели. Фолбэк на DASHBOARD_PASSWORD, если API_TOKEN не задан.
const API_TOKEN = process.env.API_TOKEN || '';
function bearerOk(req: Request): boolean {
  const m = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const expected = API_TOKEN || PASSWORD;
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(m[1].trim()).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (verifySession(parseCookies(req.headers.cookie)[COOKIE])) return next();
  if (bearerOk(req)) return next();
  if ((req.get('accept') || '').includes('application/json')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login');
}

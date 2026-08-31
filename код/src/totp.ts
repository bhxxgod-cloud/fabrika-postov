import { createHmac } from 'crypto';

// base32 (RFC 4648) → Buffer. Игнорируем пробелы/паддинг/регистр (сиды приходят группами «IYGR UVMZ …»).
function base32Decode(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(s).replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = A.indexOf(ch);
    if (idx < 0) continue; // мусорный символ — пропускаем
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >> bits) & 0xff); }
  }
  return Buffer.from(out);
}

// TOTP по RFC 6238: HMAC-SHA1, 6 знаков, окно 30с (как Google Authenticator / 2fa.fb.tools).
export function totpCode(secret: string, forTimeMs: number = Date.now(), step = 30, digits = 6): string {
  const key = base32Decode(secret);
  if (!key.length) throw new Error('пустой/битый 2FA-ключ');
  let counter = Math.floor(forTimeMs / 1000 / step);
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) { buf[i] = counter & 0xff; counter = Math.floor(counter / 256); }
  const h = createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

// Сколько секунд до смены кода.
export function totpRemaining(forTimeMs: number = Date.now(), step = 30): number {
  return step - (Math.floor(forTimeMs / 1000) % step);
}

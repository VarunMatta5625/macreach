import crypto from 'node:crypto';
import { sha256, safeEqual } from './util.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s) {
  let bits = 0, value = 0; const out = [];
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const i = ALPHABET.indexOf(c); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totpAt(secretB32, t = Date.now(), step = 30, digits = 6) {
  const counter = Math.floor(t / 1000 / step);
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/** Returns the matched time-step counter or null. Caller must reject counters <= last used (replay protection). */
export function verifyTotp(secretB32, code, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  let hit = null;
  for (const drift of [0, -1, 1]) {
    const t = now + drift * 30000;
    if (safeEqual(totpAt(secretB32, t), c) && hit === null) hit = Math.floor(t / 1000 / 30);
  }
  return hit;
}

export const newSecret = () => base32(crypto.randomBytes(20));
export const otpauthUri = (secret, account, issuer = 'MacReach') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

export function newRecoveryCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = base32(crypto.randomBytes(8)).slice(0, 10).toLowerCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}
export const hashRecovery = (code) => sha256('mr-recovery:' + code.toLowerCase().replace(/[^a-z2-7]/g, ''));

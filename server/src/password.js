import crypto from 'node:crypto';
import { promisify } from 'node:util';

const argon2 = promisify(crypto.argon2);
const P = { m: 65536, t: 3, p: 4, len: 32 };

async function derive(password, salt, { m, t, p, len }) {
  const key = await argon2('argon2id', { message: Buffer.from(password, 'utf8'), nonce: salt, parallelism: p, tagLength: len, memory: m, passes: t });
  return Buffer.from(key);
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await derive(password, salt, P);
  return `$argon2id$v=19$m=${P.m},t=${P.t},p=${P.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, encoded) {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(encoded || '');
  if (!m) return false;
  const salt = Buffer.from(m[4], 'base64'), want = Buffer.from(m[5], 'base64');
  const got = await derive(password, salt, { m: +m[1], t: +m[2], p: +m[3], len: want.length });
  return crypto.timingSafeEqual(got, want);
}

// Burns equal CPU when the username doesn't exist or no password is set yet.
const DUMMY = '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
export const burn = (password) => verifyPassword(password, DUMMY).catch(() => false);

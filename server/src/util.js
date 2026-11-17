import crypto from 'node:crypto';

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isLocalHost(host) {
  const h = (host || '').toLowerCase().replace(/:\d+$/, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

/** Connections only ever arrive from loopback (we bind 127.0.0.1), i.e. from the tunnel / Tailscale proxy.
 *  The proxy appends the real client to X-Forwarded-For, so the right-most entry is the trustworthy one. */
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const randomToken = (n = 32) => b64url(crypto.randomBytes(n));
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

export function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "Android Chrome", "iPhone Safari", "Mac Chrome"... for notifications and the menu bar. */
export function deviceName(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'Mac' : /Linux|X11/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${os} ${br}`;
}

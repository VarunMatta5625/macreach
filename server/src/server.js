import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { WEB_DIR, DATA_DIR } from './paths.js';
import { parseCookies, isLocalHost, clientIp, readBody, safeEqual, sleep, randomToken } from './util.js';
import { readAuth, updateAuth, Sessions } from './authstore.js';
import { loadConfig } from './config.js';
import { verifyPassword, burn } from './password.js';
import { verifyTotp, hashRecovery } from './totp.js';
import { LoginLimiter } from './ratelimit.js';
import { audit, readAudit } from './audit.js';
import { notify } from './notify.js';
import * as files from './files.js';
import { Hub } from './hub.js';

const COOKIE = 'mr_sid';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

export function createServer({ config, helper, getConfig }) {
  const sessions = new Sessions(config);
  const hub = new Hub({ config, helper, sessions });
  const limiter = new LoginLimiter(config.security, (ev) => {
    audit({ event: 'lockout', ...ev });
    notify('Remote access locked out', ev.scope === 'ip' ? `Too many failed logins from ${ev.ip}` : 'Too many failed logins overall');
  });
  setInterval(() => limiter.gc(), 60000).unref();
  const startedAt = Date.now();

  // ---------- helpers ----------
  const hostOf = (req) => String(req.headers.host || '').toLowerCase();
  const hostAllowed = (req) => {
    const h = hostOf(req);
    if (isLocalHost(h)) return true;
    const bare = h.replace(/:\d+$/, '');
    return config.hosts.some((x) => x.toLowerCase() === bare || x.toLowerCase() === h);
  };
  // Tailscale Serve/Funnel and tunnels reach us from 127.0.0.1, so "local" can't be inferred from the peer address.
  // Cookies are Secure unless this is a direct local-dev request (local Host AND no proxy markers) and forceSecureCookies is off.
  const PROXY_MARKERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'via', 'cf-ray', 'cf-connecting-ip', 'tailscale-user-login', 'tailscale-funnel-request'];
  const proxied = (req) => PROXY_MARKERS.some((h) => req.headers[h] !== undefined);
  const isSecureCtx = (req) => !!config.security.forceSecureCookies || !isLocalHost(hostOf(req)) || proxied(req);
  const originOk = (req) => {
    const o = req.headers.origin;
    if (!o) return false;
    try { return new URL(o).host.toLowerCase() === hostOf(req); } catch { return false; }
  };
  const securityHeaders = (req) => {
    const host = hostOf(req);
    const h = {
      'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws://${host} wss://${host}; worker-src 'self' blob:; media-src 'self' blob:; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(self), clipboard-write=(self), fullscreen=(self), keyboard-map=(self)',
      'Cache-Control': 'no-store',
    };
    if (isSecureCtx(req)) h['Strict-Transport-Security'] = 'max-age=31536000';
    return h;
  };
  const sessionOf = (req) => sessions.get(parseCookies(req.headers.cookie)[COOKIE]);
  const send = (req, res, status, body, extra = {}) => {
    const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
    const payload = isObj ? JSON.stringify(body) : body;
    res.writeHead(status, { ...securityHeaders(req), 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', ...extra });
    res.end(payload);
  };
  const notFound = (req, res) => send(req, res, 404, 'Not found');
  const cookieHeader = (req, value, maxAge) =>
    `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/${isSecureCtx(req) ? '; Secure' : ''}${maxAge !== undefined ? `; Max-Age=${maxAge}` : ''}`;

  // ---------- static (cached, compressed) ----------
  const cache = new Map();
  async function serveStatic(req, res, rel, base) {
    const full = path.resolve(base, rel);
    if (full !== base && !full.startsWith(base + path.sep)) return notFound(req, res);
    let st;
    try { st = await fsp.stat(full); } catch { return notFound(req, res); }
    if (!st.isFile()) return notFound(req, res);
    const ext = path.extname(full).toLowerCase();
    let e = cache.get(full);
    if (!e || e.mtime !== st.mtimeMs) {
      const raw = await fsp.readFile(full);
      const compressible = /\.(html|js|mjs|css|json|webmanifest|svg|txt)$/.test(ext);
      e = { mtime: st.mtimeMs, raw, br: compressible ? zlib.brotliCompressSync(raw) : null, etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url') + '"' };
      cache.set(full, e);
    }
    const headers = { ...securityHeaders(req), 'Content-Type': TYPES[ext] || 'application/octet-stream', ETag: e.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, headers); return res.end(); }
    if (e.br && /\bbr\b/.test(req.headers['accept-encoding'] || '')) { headers['Content-Encoding'] = 'br'; res.writeHead(200, headers); return res.end(e.br); }
    res.writeHead(200, headers); res.end(e.raw);
  }

  // ---------- login ----------
  async function login(req, res) {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json' || !originOk(req)) return notFound(req, res);
    const ip = clientIp(req), ua = req.headers['user-agent'];
    let body;
    try { body = JSON.parse((await readBody(req, 4096)).toString('utf8')); } catch { return send(req, res, 400, { error: 'Bad request' }); }
    const lim = limiter.check(ip);
    if (!lim.ok) {
      audit({ event: 'login', ok: false, reason: 'throttled:' + lim.scope, ip, ua });
      return send(req, res, 429, { error: 'Too many attempts. Try again later.', retryAfter: lim.retryAfter }, { 'Retry-After': String(lim.retryAfter) });
    }
    const username = String(body.username ?? '').slice(0, 100), password = String(body.password ?? '').slice(0, 1024);
    const auth = readAuth();
    const userOk = !!auth?.hash && safeEqual(username, auth.username || '');
    const pwOk = userOk ? await verifyPassword(password, auth.hash).catch(() => false) : (await burn(password), false);
    const fail = async (reason) => {
      limiter.fail(ip);
      audit({ event: 'login', ok: false, reason, user: username.slice(0, 40), ip, ua });
      await sleep(250 + Math.random() * 250);
      return send(req, res, 401, { error: 'Invalid credentials' });
    };
    if (!(userOk && pwOk)) return fail(auth?.hash ? 'bad-credentials' : 'not-configured');

    // Tailscale Serve strips any client-supplied Tailscale-User-* header and sets it itself only for tailnet traffic; Funnel (public)
    // traffic carries none and is marked with Tailscale-Funnel-Request. A tailnet request already came from one of the owner's own
    // devices, so the second factor adds little there. Anything that cannot prove it is tailnet traffic still gets asked for the code.
    const viaTailnet = !!req.headers['tailscale-user-login'] && !req.headers['tailscale-funnel-request'];
    const skipTotp = viaTailnet && !config.totp.requireOnTailnet;
    if (skipTotp && config.totp.enabled && auth.totp?.secret) audit({ event: 'totp-skipped', reason: 'tailnet', user: username.slice(0, 40), ip });
    if (config.totp.enabled && auth.totp?.secret && !skipTotp) {
      const code = body.totp ? String(body.totp) : '', rec = body.recovery ? String(body.recovery) : '';
      if (!code && !rec) { audit({ event: 'login', ok: false, reason: 'awaiting-totp', user: username.slice(0, 40), ip, ua }); return send(req, res, 200, { need: 'totp' }); }
      let good = false;
      if (code) {
        const step = verifyTotp(auth.totp.secret, code);
        // check-and-set against fresh state: a code can be used once even by parallel requests
        if (step !== null) good = updateAuth((a) => { if (!a.totp || step <= (a.totp.lastStep || 0)) return false; a.totp.lastStep = step; return true; }) === true;
      } else {
        const h = hashRecovery(rec);
        good = updateAuth((a) => { const i = (a.totp?.recovery || []).indexOf(h); if (i < 0) return false; a.totp.recovery.splice(i, 1); return true; }) === true;
        if (good) { audit({ event: 'recovery-code-used', ip }); notify('Recovery code used', 'A 2FA recovery code was used to sign in.'); }
      }
      if (!good) return fail('bad-totp');
    }
    limiter.success(ip);
    const remember = !!body.remember && config.session.rememberDevice.enabled;
    const { id, session } = sessions.create({ ip, ua, user: auth.username, remember });
    audit({ event: 'login', ok: true, user: auth.username, ip, ua, remember });
    const maxAge = remember ? config.session.rememberDevice.days * 86400 : undefined;
    return send(req, res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, id, maxAge) });
  }

  // ---------- main request handler ----------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (config.paused) return send(req, res, 503, 'Unavailable', { 'Retry-After': '300' });
    if (!hostAllowed(req)) return notFound(req, res);

    if (p === '/' || p === '/index.html') {
      const s = sessionOf(req);
      return serveStatic(req, res, s ? 'app/index.html' : 'public/login.html', WEB_DIR);
    }
    if (p === '/_/opts.json') return send(req, res, 200, { remember: !!config.session.rememberDevice.enabled });
    if (p.startsWith('/_/')) return serveStatic(req, res, 'public/' + p.slice(3), WEB_DIR);
    if (p === '/api/login' && req.method === 'POST') return login(req, res);

    const s = sessionOf(req);
    if (p.startsWith('/a/')) { if (!s) return notFound(req, res); return serveStatic(req, res, 'app/' + p.slice(3), WEB_DIR); }
    if (!p.startsWith('/api/')) return notFound(req, res);
    if (!s) return send(req, res, 401, { error: 'Unauthorized' });

    const mutating = !['GET', 'HEAD'].includes(req.method);
    if (mutating && (!originOk(req) || !safeEqual(req.headers['x-csrf'] || '', s.csrf))) return send(req, res, 403, { error: 'Forbidden' });
    sessions.touch(s);

    try {
      if (p === '/api/session' && req.method === 'GET') {
        const id = parseCookies(req.headers.cookie)[COOKIE];
        void id;
        return send(req, res, 200, { user: s.user, csrf: s.csrf, created: s.created, lastActive: s.lastActive, limits: sessions.limits(s.remember), clipboard: config.clipboard.sync, uploadDir: config.files.uploadDir, takeover: config.security.allowTakeover });
      }
      if (p === '/api/logout' && req.method === 'POST') {
        sessions.destroy(parseCookies(req.headers.cookie)[COOKIE]);
        if (hub.active?.session.idHash === s.idHash) hub.kickActive('logout');
        return send(req, res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, '', 0) });
      }
      if (p === '/api/files/list' && req.method === 'GET') return send(req, res, 200, await files.listDir(config, url.searchParams.get('path') || ''));
      if (p === '/api/files/download' && (req.method === 'GET' || req.method === 'HEAD')) return await files.download(config, req, res, url.searchParams.get('path') || '');
      if (p === '/api/files/upload' && req.method === 'PUT') {
        const r = await files.upload(config, req, url.searchParams.get('name'), url.searchParams.get('dir') || '');
        audit({ event: 'upload', path: r.path, size: r.size, ip: clientIp(req) });
        return send(req, res, 200, r);
      }
    } catch (e) {
      return send(req, res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    }
    return notFound(req, res);
  }

  // Control API for the CLI: served only on a 0600 Unix socket (never on the TCP listener that tunnels reach).
  async function ctl(req, res) {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/_ctl/status') {
      return send(req, res, 200, {
        uptime: Math.round((Date.now() - startedAt) / 1000), helperUp: helper.up, helper: helper.status,
        active: hub.activeInfo(), sessions: sessions.map.size, audit: readAudit(10), hosts: config.hosts, port: server.address()?.port ?? config.port,
      });
    }
    if (p === '/_ctl/reload' && req.method === 'POST') {   // re-read config.json into the live config; apply pause immediately
      Object.assign(config, loadConfig());
      if (config.paused) hub.kickActive('paused');
      hub.pushSession();
      return send(req, res, 200, { ok: true, paused: !!config.paused });
    }
    if (p === '/_ctl/perms' && req.method === 'POST') { helper.send({ c: 'perms' }); return send(req, res, 200, { ok: helper.up }); }
    if (p === '/_ctl/kick' && req.method === 'POST') { hub.kickActive('admin'); return send(req, res, 200, { ok: true }); }
    if (p === '/_ctl/revoke-all' && req.method === 'POST') { sessions.destroyAll(); hub.kickActive('revoked'); return send(req, res, 200, { ok: true }); }
    if (p === '/_ctl/audit') return send(req, res, 200, readAudit(Number(new URL(req.url, 'http://x').searchParams.get('n')) || 50));
    return notFound(req, res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { console.error('request error', e.message); if (!res.headersSent) send(req, res, 500, 'Error'); else res.destroy(); });
  });
  const ctlServer = http.createServer((req, res) => {
    ctl(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  server.requestTimeout = 0; // long uploads/downloads
  server.headersTimeout = 20000;

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 32 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const deny = () => { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); };
    const url = new URL(req.url, 'http://x');
    if (config.paused || url.pathname !== '/ws' || !hostAllowed(req) || !originOk(req)) return deny();
    const s = sessionOf(req);
    if (!s) return deny();
    wss.handleUpgrade(req, socket, head, (ws) => {
      socket.setNoDelay(true);
      // A browser on this very Mac (direct localhost, not via a proxy) sees its own screen: injected input would fight the real mouse.
      const selfView = !proxied(req) && isLocalHost(hostOf(req)) && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      hub.handleConnection(ws, s, clientIp(req), req.headers['user-agent'], selfView);
    });
  });

  return { server, ctlServer, hub, sessions, limiter };
}

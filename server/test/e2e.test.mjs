// End-to-end tests: spawn the real server on a temp data dir (no helper needed) and exercise auth, CSRF,
// rate limiting, sessions, files and WebSocket gating. Run: node --test server/test
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { hashPassword } from '../src/password.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 7890 + Math.floor(Math.random() * 50);
const BASE = `http://localhost:${PORT}`;
const PW = 'correct horse battery staple';
let proc, dataDir, homeDir;

const J = { 'content-type': 'application/json', origin: BASE };
const cookieOf = (r) => (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');

async function login(pw = PW, extra = {}) {
  return fetch(`${BASE}/api/login`, { method: 'POST', headers: { ...J, ...extra }, body: JSON.stringify({ username: 'tester', password: pw }) });
}
async function session(r) {
  const cookie = cookieOf(r);
  const s = await (await fetch(`${BASE}/api/session`, { headers: { cookie } })).json();
  return { cookie, csrf: s.csrf, s };
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrh-'));
  fs.writeFileSync(path.join(homeDir, 'hello.txt'), 'hi there');
  fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ username: 'tester', hash: await hashPassword(PW), totp: null }), { mode: 0o600 });
  proc = spawn(process.execPath, [path.join(here, '../src/index.js')], {
    env: { ...process.env, MACREACH_DATA_DIR: dataDir, MACREACH_PORT: String(PORT), MACREACH_HELPER_SOCK: path.join(dataDir, 'h.sock'), HOME: homeDir },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('server did not start');
});
test.after(() => { proc?.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(homeDir, { recursive: true, force: true }); });

test('app and API are not reachable without a session; response is generic', async () => {
  for (const p of ['/a/js/main.js', '/api/session', '/api/files/list']) {
    const r = await fetch(BASE + p);
    assert.ok([401, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  const html = await (await fetch(`${BASE}/`)).text();
  assert.match(html, /Sign in/);
});

test('security headers present', async () => {
  const r = await fetch(`${BASE}/`);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

test('unknown Host header is rejected', async () => {
  const status = await new Promise((res, rej) => {
    const q = http.request({ host: '127.0.0.1', port: PORT, path: '/', headers: { host: 'evil.example' } }, (r) => { r.resume(); res(r.statusCode); });
    q.on('error', rej); q.end();
  });
  assert.equal(status, 404);
});

test('login: wrong credentials generic 401, then correct password works; cookie flags', async () => {
  const bad = await login('wrong');
  assert.equal(bad.status, 401);
  const ok = await login();
  assert.equal(ok.status, 200);
  const sc = (ok.headers.getSetCookie?.() || []).join('\n');
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Strict/i);
});

test('login requires same Origin', async () => {
  const r = await login(PW, { origin: 'https://evil.example' });
  assert.ok([401, 403, 404].includes(r.status) && !cookieOf(r), `status ${r.status}`);
});

test('CSRF: mutating API call without token is refused; with token passes', async () => {
  await new Promise((r) => setTimeout(r, 2500)); // let the failed-login backoff elapse
  const { cookie, csrf } = await session(await login());
  const noTok = await fetch(`${BASE}/api/logout`, { method: 'POST', headers: { cookie, origin: BASE } });
  assert.equal(noTok.status, 403);
  const wrongOrigin = await fetch(`${BASE}/api/logout`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'x-csrf': csrf } });
  assert.equal(wrongOrigin.status, 403);
  const good = await fetch(`${BASE}/api/logout`, { method: 'POST', headers: { cookie, origin: BASE, 'x-csrf': csrf } });
  assert.equal(good.status, 200);
  const after = await fetch(`${BASE}/api/session`, { headers: { cookie } });
  assert.equal(after.status, 401);
});

test('files: list, download, path traversal blocked, upload round-trip', async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const { cookie, csrf } = await session(await login());
  const list = await (await fetch(`${BASE}/api/files/list?path=${encodeURIComponent(homeDir)}`, { headers: { cookie } })).json();
  assert.ok(JSON.stringify(list).includes('hello.txt'));
  const dl = await fetch(`${BASE}/api/files/download?path=${encodeURIComponent(path.join(homeDir, 'hello.txt'))}`, { headers: { cookie } });
  assert.equal(await dl.text(), 'hi there');
  const trav = await fetch(`${BASE}/api/files/download?path=${encodeURIComponent(path.join(homeDir, '..', '..', 'etc', 'hosts'))}`, { headers: { cookie } });
  assert.ok(trav.status >= 400, `traversal status ${trav.status}`);
  const up = await fetch(`${BASE}/api/files/upload?name=up.bin`, { method: 'PUT', headers: { cookie, origin: BASE, 'x-csrf': csrf, 'content-type': 'application/octet-stream' }, body: Buffer.from('payload') });
  assert.equal(up.status, 200);
  assert.ok(fs.existsSync(path.join(homeDir, 'Downloads', 'MacReach', 'up.bin')));
  const noCsrf = await fetch(`${BASE}/api/files/upload?name=x.bin`, { method: 'PUT', headers: { cookie, origin: BASE }, body: 'x' });
  assert.equal(noCsrf.status, 403);
});

test('websocket: refused without cookie or with foreign Origin; second controller gets takeover flow', async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const open = (headers) => new Promise((res) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers });
    ws.on('open', () => res({ ws, ok: true }));
    ws.on('unexpected-response', (_q, r) => res({ ok: false, status: r.statusCode }));
    ws.on('error', () => res({ ok: false }));
  });
  const anon = await open({ origin: BASE });
  assert.equal(anon.ok, false);
  const { cookie } = await session(await login());
  const foreign = await open({ origin: 'https://evil.example', cookie });
  assert.equal(foreign.ok, false);
  const a = await open({ origin: BASE, cookie });
  assert.equal(a.ok, true);
  a.ws.close();
});

function wsClient(cookie) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { origin: BASE, cookie } });
    const msgs = [], closes = [];
    ws.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
    ws.on('close', (code) => closes.push(code));
    ws.on('open', () => res({ ws, msgs, closes }));
    ws.on('error', rej);
  });
}
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

test('single controller: second login gets busy prompt; takeover kicks the first and is audited', async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const A = await session(await login());
  const B = await session(await login());
  const a = await wsClient(A.cookie);
  assert.ok(await until(() => a.msgs.some((m) => m.t === 'ready')), 'A becomes controller');
  const b = await wsClient(B.cookie);
  assert.ok(await until(() => b.msgs.some((m) => m.t === 'busy' && m.allowTakeover)), 'B is told it is busy');
  assert.ok(!b.msgs.some((m) => m.t === 'ready'), 'B must not control before takeover');
  b.ws.send(JSON.stringify({ t: 'kd', k: 'KeyA' })); // input from a pending client is ignored
  b.ws.send(JSON.stringify({ t: 'takeover' }));
  assert.ok(await until(() => b.msgs.some((m) => m.t === 'ready')), 'B is promoted');
  assert.ok(await until(() => a.msgs.some((m) => m.t === 'taken')), 'A is told it was taken');
  assert.ok(await until(() => a.closes.includes(4001)), 'A socket closed with 4001');
  const log = fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8');
  assert.match(log, /"event":"takeover"/);
  b.ws.close();
});

test('same session reload replaces its own stale socket without a prompt', async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const S = await session(await login());
  const first = await wsClient(S.cookie);
  assert.ok(await until(() => first.msgs.some((m) => m.t === 'ready')));
  const second = await wsClient(S.cookie);
  assert.ok(await until(() => second.msgs.some((m) => m.t === 'ready')), 'reload gets control directly');
  assert.ok(!second.msgs.some((m) => m.t === 'busy'));
  assert.ok(await until(() => first.closes.includes(4004)), 'stale socket closed with 4004');
  second.ws.close();
});

function ctlGet(p, method = 'GET') {
  return new Promise((res, rej) => {
    const q = http.request({ socketPath: path.join(dataDir, 'ctl.sock'), path: p, method, headers: { host: 'localhost' } }, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ status: r.statusCode, body: b }));
    });
    q.on('error', rej); q.end();
  });
}

test('control API: absent on the TCP listener (even with localhost Host), served on the 0600 unix socket', async () => {
  for (const hdrs of [{}, { authorization: 'Bearer x' }]) {
    const r = await fetch(`${BASE}/_ctl/status`, { headers: hdrs });
    assert.equal(r.status, 404);
  }
  const mode = fs.statSync(path.join(dataDir, 'ctl.sock')).mode & 0o777;
  assert.equal(mode, 0o600);
  const r = await ctlGet('/_ctl/status');
  assert.equal(r.status, 200);
  assert.ok('helperUp' in JSON.parse(r.body));
});

test('session cookie is Secure whenever proxy markers are present, even with a localhost Host', async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const direct = await login();
  assert.doesNotMatch((direct.headers.getSetCookie?.() || []).join('\n'), /;\s*Secure/i);
  await new Promise((r) => setTimeout(r, 2500));
  const proxied = await login(PW, { 'x-forwarded-for': '203.0.113.9' });
  assert.match((proxied.headers.getSetCookie?.() || []).join('\n'), /;\s*Secure/i);
});

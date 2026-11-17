// TOTP login: required, single-use (also under parallel requests), recovery codes single-use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/password.js';
import { newSecret, totpAt, hashRecovery } from '../src/totp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 7950 + Math.floor(Math.random() * 40);
const BASE = `http://localhost:${PORT}`;
const PW = 'another long dummy passphrase';
const secret = newSecret();
const RECOVERY = 'abcde-fghij';
let proc, dir;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (extra = {}, headers = {}) => fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, ...headers }, body: JSON.stringify({ username: 'u', password: PW, ...extra }) });

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrtotp-'));
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ username: 'u', hash: await hashPassword(PW), totp: { secret, lastStep: 0, recovery: [hashRecovery(RECOVERY)] } }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ totp: { enabled: true } }));
  proc = spawn(process.execPath, [path.join(here, '../src/index.js')], { env: { ...process.env, MACREACH_DATA_DIR: dir, MACREACH_PORT: String(PORT), MACREACH_HELPER_SOCK: path.join(dir, 'h.sock') }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE); return; } catch { await sleep(100); } }
  throw new Error('no start');
});
test.after(() => { proc?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('password alone is not enough when TOTP is on', async () => {
  const r = await post();
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { need: 'totp' });
  assert.equal((r.headers.getSetCookie?.() || []).length, 0, 'no session cookie before the second factor');
});

test('valid code logs in once; replay of the same code is rejected', async () => {
  const code = totpAt(secret);
  const a = await post({ totp: code });
  assert.equal(a.status, 200); assert.deepEqual(await a.json(), { ok: true });
  const b = await post({ totp: code });
  assert.equal(b.status, 401);
});

test('parallel requests with the same fresh code: exactly one wins', async () => {
  await sleep(2500);
  const code = totpAt(secret, Date.now() + 30000); // next step, inside the allowed drift window
  const rs = await Promise.all([post({ totp: code }), post({ totp: code }), post({ totp: code })]);
  const ok = rs.filter((r) => r.status === 200).length;
  assert.equal(ok, 1, `successes: ${rs.map((r) => r.status)}`);
});

test('wrong code rejected; recovery code works exactly once', async () => {
  await sleep(4000);
  assert.equal((await post({ totp: '000000' })).status, 401);
  await sleep(4000);
  assert.equal((await post({ recovery: RECOVERY })).status, 200);
  await sleep(4000);
  assert.equal((await post({ recovery: RECOVERY })).status, 401);
});

test('a tailnet login (Tailscale identity header) does not need the code; a Funnel login or a bare request does', async () => {
  await sleep(1000);
  const tailnet = await post({}, { 'Tailscale-User-Login': 'owner@example.com' });
  assert.equal(tailnet.status, 200); assert.deepEqual(await tailnet.json(), { ok: true });
  const funnel = await post({}, { 'Tailscale-User-Login': 'owner@example.com', 'Tailscale-Funnel-Request': '?1' });
  assert.deepEqual(await funnel.json(), { need: 'totp' }, 'funnel marker wins over an identity header');
  const bare = await post();
  assert.deepEqual(await bare.json(), { need: 'totp' }, 'no header: asked for the code');
  const wrong = await post({ password: 'wrong' }, { 'Tailscale-User-Login': 'owner@example.com' });
  assert.equal(wrong.status, 401, 'the password is still required on the tailnet');
});

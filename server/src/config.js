import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, HOME, ensureDirs } from './paths.js';

export const DEFAULTS = {
  port: 7878,
  bind: '127.0.0.1',
  // extra Host header values accepted (tailnet / public name). localhost is always accepted.
  hosts: [],
  session: { idleMinutes: 30, absoluteHours: 12, rememberDevice: { enabled: false, days: 30 } },
  security: {
    perIpFailLimit: 8, perIpWindowMinutes: 15, perIpLockMinutes: 15,
    globalFailLimit: 30, globalWindowMinutes: 10, globalLockMinutes: 5,
    maxBackoffSeconds: 60, allowTakeover: true,
    forceSecureCookies: false, // set true once served over HTTPS (tailscale serve) so a rewritten Host can never downgrade cookies
  },
  paused: false, // remote access paused (CLI: macreach access pause)
  // requireOnTailnet: also ask for the code on private (tailnet) logins; by default only public Funnel and local logins need it
  totp: { enabled: false, requireOnTailnet: false },
  clipboard: { sync: true },
  files: { roots: [HOME], uploadDir: path.join(HOME, 'Downloads', 'MacReach'), maxUploadGB: 20 },
  video: { maxLevel: 5, defaultLevel: 3 },
};

function merge(a, b) {
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') out[k] = merge(a[k], v);
    else out[k] = v;
  }
  return out;
}

export function loadConfig() {
  ensureDirs();
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  const cfg = merge(DEFAULTS, user);
  cfg.files.roots = cfg.files.roots.map((r) => r.replace(/^~(?=$|\/)/, HOME));
  cfg.files.uploadDir = cfg.files.uploadDir.replace(/^~(?=$|\/)/, HOME);
  return cfg;
}

export function saveConfigPatch(patch) {
  ensureDirs();
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  user = merge(user, patch);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(user, null, 2) + '\n', { mode: 0o600 });
  return user;
}

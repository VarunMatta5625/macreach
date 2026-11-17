import fs from 'node:fs';
import { AUTH_FILE, SESSIONS_FILE } from './paths.js';
import { randomToken, sha256 } from './util.js';

/** auth.json (0600): { username, hash, totp: { secret, lastStep, recovery: [sha256...] } | null } */
export function readAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; }
}
export function writeAuth(obj) {
  const tmp = AUTH_FILE + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, AUTH_FILE);                 // atomic: a crash can never leave a truncated auth.json
}
/** Synchronous read-modify-write (no await inside => atomic w.r.t. other requests). Writes only if fn !== false; returns fn's result. */
export function updateAuth(fn) {
  const a = readAuth(); if (!a) return false;
  const r = fn(a);
  if (r !== false) writeAuth(a);
  return r;
}

/** Sessions persisted by sha256(id) so a server restart doesn't log you out and the file holds no usable cookies. */
export class Sessions {
  constructor(config) {
    this.config = config;
    this.map = new Map(); // idHash -> session
    this.load();
    this.timer = setInterval(() => this.sweep(), 30000);
    this.timer.unref?.();
  }
  load() {
    try {
      const arr = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      for (const s of arr) this.map.set(s.idHash, s);
      this.sweep();
    } catch {}
  }
  save() {
    try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify([...this.map.values()]), { mode: 0o600 }); } catch {}
  }
  limits(remember) {
    const s = this.config.session;
    if (remember && s.rememberDevice.enabled) return { idle: s.rememberDevice.days * 86400e3, abs: s.rememberDevice.days * 86400e3 };
    return { idle: s.idleMinutes * 60e3, abs: s.absoluteHours * 3600e3 };
  }
  create({ ip, ua, user, remember }) {
    const id = randomToken(32);
    const now = Date.now();
    const s = { idHash: sha256(id), csrf: randomToken(24), created: now, lastActive: now, ip, ua: String(ua || '').slice(0, 200), user, remember: !!remember };
    this.map.set(s.idHash, s); this.save();
    return { id, session: s };
  }
  expired(s, now = Date.now()) {
    const l = this.limits(s.remember);
    return (l.idle > 0 && now - s.lastActive > l.idle) || (l.abs > 0 && now - s.created > l.abs);
  }
  get(id) {
    if (!id) return null;
    const s = this.map.get(sha256(id));
    if (!s) return null;
    if (this.expired(s)) { this.map.delete(s.idHash); this.save(); return null; }
    return s;
  }
  /** Mark real user activity (input, API use). Throttled disk writes. */
  touch(s) {
    const now = Date.now();
    if (now - s.lastActive > 1000) { s.lastActive = now; if (now - (this._saved || 0) > 60000) { this._saved = now; this.save(); } }
  }
  destroy(id) { const h = sha256(id); if (this.map.delete(h)) this.save(); }
  destroyAll() { this.map.clear(); this.save(); }
  sweep() {
    let changed = false;
    for (const [k, s] of this.map) if (this.expired(s)) { this.map.delete(k); changed = true; }
    if (changed) this.save();
  }
}

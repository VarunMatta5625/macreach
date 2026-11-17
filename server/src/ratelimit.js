/** Login throttling: per-IP and global failure windows, exponential backoff, temporary lockout.
 *  check() is called BEFORE any password hashing so floods can't burn CPU. */
export class LoginLimiter {
  constructor(cfg, onLock) {
    this.cfg = cfg; this.onLock = onLock;
    this.ips = new Map();   // ip -> { fails: [ts...], lockedUntil, streak, nextOkAt }
    this.globalFails = []; this.globalLockedUntil = 0;
  }
  _ip(ip) {
    let r = this.ips.get(ip);
    if (!r) { r = { fails: [], lockedUntil: 0, streak: 0, nextOkAt: 0 }; this.ips.set(ip, r); }
    return r;
  }
  _prune(arr, windowMs, now) { while (arr.length && now - arr[0] > windowMs) arr.shift(); }
  /** returns { ok:true } or { ok:false, retryAfter(seconds), scope } */
  check(ip, now = Date.now()) {
    if (now < this.globalLockedUntil) return { ok: false, retryAfter: Math.ceil((this.globalLockedUntil - now) / 1000), scope: 'global' };
    const r = this._ip(ip);
    if (now < r.lockedUntil) return { ok: false, retryAfter: Math.ceil((r.lockedUntil - now) / 1000), scope: 'ip' };
    if (now < r.nextOkAt) return { ok: false, retryAfter: Math.ceil((r.nextOkAt - now) / 1000), scope: 'backoff' };
    return { ok: true };
  }
  fail(ip, now = Date.now()) {
    const c = this.cfg, r = this._ip(ip);
    r.fails.push(now); this._prune(r.fails, c.perIpWindowMinutes * 60e3, now);
    r.streak++;
    if (r.fails.length >= c.perIpFailLimit) {
      r.lockedUntil = now + c.perIpLockMinutes * 60e3; r.fails = []; r.streak = 0;
      this.onLock?.({ scope: 'ip', ip, minutes: c.perIpLockMinutes });
    } else if (r.streak > 2) {
      r.nextOkAt = now + Math.min(2 ** (r.streak - 2), c.maxBackoffSeconds) * 1000;
    }
    this.globalFails.push(now); this._prune(this.globalFails, c.globalWindowMinutes * 60e3, now);
    if (this.globalFails.length >= c.globalFailLimit) {
      this.globalLockedUntil = now + c.globalLockMinutes * 60e3; this.globalFails = [];
      this.onLock?.({ scope: 'global', minutes: c.globalLockMinutes });
    }
  }
  success(ip) { const r = this._ip(ip); r.fails = []; r.streak = 0; r.nextOkAt = 0; }
  gc(now = Date.now()) {
    for (const [ip, r] of this.ips) if (now > r.lockedUntil && now > r.nextOkAt && r.fails.length === 0) this.ips.delete(ip);
  }
}

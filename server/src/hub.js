import { QualityController, LADDER } from './quality.js';
import { audit } from './audit.js';
import { deviceName } from './util.js';

const CMDS = new Set(['missionControl', 'launchpad', 'displaySleep']);
const LIVENESS_MS = 25_000;
const KEY_RE = /^[A-Za-z0-9]{1,20}$/;
const num = (v, lo, hi, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const FORWARD_FROM_HELPER = new Set(['videoConfig', 'status', 'display', 'streamState', 'streamError', 'clip']);

/** Owns the single controlling session: admits/takes over clients, bridges input to the helper, video to the client. */
export class Hub {
  constructor({ config, helper, sessions }) {
    this.config = config; this.helper = helper; this.sessions = sessions;
    this.active = null;
    this.clients = new Set();
    helper.on('video', (p) => this._onVideo(p));
    helper.on('json', (j) => this._onHelperJson(j));
    helper.on('up', () => { this.pushSession(); if (this.active?.attached) this._startHelper(this.active); });
    helper.on('down', () => { if (this.active) this._send(this.active, { t: 'helperDown' }); });
    this.timer = setInterval(() => this._tick(), 500);
    this.timer.unref?.();
    this._seqGen = 0; this._pend = null;
    this._levels = new Map();   // session id hash -> { level, t }: last quality level a session settled at
  }

  /** Tell the Mac-side helper who is in control, so the menu bar icon can show it. Safe to call any time. */
  pushSession() {
    const a = this.active;
    this.helper.send({ c: 'session', active: !!a, device: a ? deviceName(a.ua) : '', ip: a?.ip || '', since: a ? a.since : 0, selfView: !!a?.selfView, paused: !!this.config.paused });
  }

  activeInfo() {
    const a = this.active;
    return a ? { ip: a.ip, ua: a.ua, since: a.since, attached: a.attached, quality: a.q?.stats() } : null;
  }

  kickActive(reason = 'ended') {
    if (this.active) this._close(this.active, 4003, { t: 'ended', reason });
  }

  handleConnection(ws, session, ip, ua, selfView = false) {
    const c = { selfView, allowSelf: false, ws, session, ip, ua: String(ua || '').slice(0, 160), active: false, attached: false, pending: false, since: Date.now(), q: null, msgCount: 0, msgWindow: Date.now(), clipSync: false, codecs: ['jpeg'] };
    this.clients.add(c);
    ws.on('message', (data, isBinary) => { ws.lastSeen = Date.now(); if (!isBinary) this._onMessage(c, data); });
    ws.on('close', () => this._onClose(c));
    ws.on('error', () => {});
    ws.lastSeen = Date.now();
    ws.on('pong', () => { ws.lastSeen = Date.now(); });

    const cur = this.active;
    if (!cur) return this._activate(c);
    if (cur.session.idHash === c.session.idHash) { // same login reconnecting (network blip / reload)
      this._close(cur, 4004, { t: 'replaced' }, true);
      return this._activate(c);
    }
    if (!this.config.security.allowTakeover) { this._close(c, 4005, { t: 'busy', allowTakeover: false }); return; }
    c.pending = true;
    this._send(c, { t: 'busy', allowTakeover: true, other: { ip: cur.ip, ua: cur.ua, since: cur.since } });
  }

  _activate(c) {
    c.pending = false; c.active = true; this.active = c; c.since = Date.now();
    audit({ event: 'control-start', ip: c.ip, ua: c.ua });
    this.pushSession();
    this._send(c, { t: 'ready', status: this.helper.status, helperUp: this.helper.up, ladder: LADDER.map((l) => l.name), clipboard: this.config.clipboard.sync, files: true, selfView: c.selfView });
  }

  _onClose(c) {
    this.clients.delete(c);
    if (this.active === c) this._release(c);
  }

  _release(c) {
    this.active = null;
    this._cancelSeq();                       // drop paced keys + queued input of the departing controller
    this.helper.send({ c: 'rel' });          // always release held keys/buttons, even if never attached
    if (c.attached) {
      this.helper.send({ c: 'clipwatch', on: false });
      this.helper.send({ c: 'stop' });
    }
    if (c.q?.auto && c.attached) this._levels.set(c.session.idHash, { level: c.q.level, t: Date.now() });
    c.attached = false; c.active = false;
    audit({ event: 'control-end', ip: c.ip });
    this.pushSession();
  }

  _close(c, code, msg, silent = false) {
    if (msg) this._send(c, msg);
    if (this.active === c) this._release(c);
    c.active = false; c.attached = false;
    try { c.ws.close(code, String(msg?.t || 'closed').slice(0, 100)); } catch {}
    setTimeout(() => { try { c.ws.terminate(); } catch {} }, 1500).unref?.();
    void silent;
  }

  _send(c, obj) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); }

  _startHelper(c) {
    const p = c.q.params();
    this.helper.send({ c: 'start', ...p, display: c.displayId });
    this.helper.send({ c: 'clipwatch', on: !!(this.config.clipboard.sync && c.clipSync) });
  }

  _onVideo(p) {
    const c = this.active;
    if (!c || !c.attached || c.ws.readyState !== 1) return;
    const key = (p[0] & 1) !== 0;
    const seq = p.readUInt32BE(1);
    const g = c.q.gate(key, p.length);
    if (g.needKeyframe) this.helper.send({ c: 'keyframe' });
    if (!g.send) return;
    // WS-level backstop (only meaningful when the socket itself is backing up)
    if (c.ws.bufferedAmount > 2 * 1024 * 1024 && !key) { c.q.waitKey = !c.q.jpeg; return; }
    c.q.onSent(seq, p.length);
    c.ws.send(p, { binary: true, compress: false });
  }

  _onHelperJson(j) {
    if (j.t === 'status' || j.t === 'videoConfig' || j.t === 'display' || j.t === 'streamError' || j.t === 'streamState' || j.t === 'clip') {
      const c = this.active;
      if (c && FORWARD_FROM_HELPER.has(j.t)) {
        if (j.t === 'clip' && !(this.config.clipboard.sync && c.clipSync)) return;
        this._send(c, j);
      }
    }
  }

  _tick() {
    const c = this.active;
    if (!c) return;
    // session lifetime (idle/absolute)
    if (!this.sessions.map.has(c.session.idHash) || this.sessions.expired(c.session)) return this._close(c, 4002, { t: 'expired' });
    // Liveness: any frame or pong from the client counts. The deadline must be far longer than a round trip plus the video already
    // queued ahead of the ping on the same TCP stream (over Funnel that is seconds, not milliseconds).
    const now = Date.now();
    if (now - c.ws.lastSeen > LIVENESS_MS) { try { c.ws.terminate(); } catch {} return; }
    if (now - (c.ws.lastPing || 0) > 5000) { c.ws.lastPing = now; try { c.ws.ping(); } catch {} }
    if (c.attached && c.q) {
      const p = c.q.tick();
      if (p) { this.helper.send({ c: 'quality', ...p }); }
      c._statTick = (c._statTick || 0) + 1;
      if (p || c._statTick % 2 === 0) this._send(c, { t: 'qstats', ...c.q.stats(), params: c.q.params() });
    }
  }

  _rateOk(c) {
    const now = Date.now();
    if (now - c.msgWindow > 1000) { c.msgWindow = now; c.msgCount = 0; }
    return ++c.msgCount <= 1500;
  }

  _onMessage(c, data) {
    if (!this._rateOk(c)) return;
    let m;
    try { m = JSON.parse(data.toString('utf8')); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'takeover') {
      if (!c.pending || !this.config.security.allowTakeover) return;
      const old = this.active;
      audit({ event: 'takeover', ip: c.ip, ua: c.ua, from: old?.ip });
      if (old) this._close(old, 4001, { t: 'taken', by: { ip: c.ip, ua: c.ua } });
      return this._activate(c);
    }
    if (m.t === 'ping') return this._send(c, { t: 'pong', n: m.n });
    if (c !== this.active) return;
    if (c.selfView && !c.allowSelf && ['mm', 'mb', 'wh', 'kd', 'ku', 'txt', 'seq', 'rel'].includes(m.t)) return;   // self-view: input off unless the user opts in
    if (m.t === 'selfInput') { if (c.selfView) c.allowSelf = !!m.on; return; }
    const input = this._input(c, m);
    if (input) { this.sessions.touch(c.session); return; }
    switch (m.t) {
      case 'ack': if (c.q && Number.isInteger(m.seq)) c.q.onAck(m.seq); break;
      case 'attach': return this._attach(c, m);
      case 'quality': return this._qualityPref(c, m);
      case 'keyframe': this.helper.send({ c: 'keyframe' }); break;
      case 'display': if (Number.isInteger(m.id)) { c.displayId = m.id; if (c.attached) this.helper.send({ c: 'quality', ...c.q.params(), display: m.id }); } break;
      case 'clip': this._clip(c, m); break;
      case 'clipPull': this.helper.send({ c: 'clippull' }); break;
      case 'clipSync': c.clipSync = !!m.on; this.helper.send({ c: 'clipwatch', on: !!(this.config.clipboard.sync && c.clipSync) }); break;
      case 'cmd': if (CMDS.has(m.n)) this.helper.send({ c: 'cmd', n: m.n }); this.sessions.touch(c.session); break;
      case 'scrollInvert': this.helper.send({ c: 'scrollInvert', on: !!m.on }); break;
      case 'perms': this.helper.send({ c: 'perms' }); break;
      case 'status': this.helper.send({ c: 'status' }); break;
      case 'detach': if (c.attached) { c.attached = false; this.helper.send({ c: 'stop' }); } break;
    }
  }

  _attach(c, m) {
    const codecs = Array.isArray(m.codecs) ? m.codecs.filter((x) => x === 'h264' || x === 'jpeg') : ['jpeg'];
    const jpeg = !codecs.includes('h264');
    const v = this.config.video;
    c.codecs = codecs;
    c.clipSync = !!m.clipSync;
    c.displayId = Number.isInteger(m.display) ? m.display : undefined;
    const auto = m.mode !== 'fixed';
    const maxLevel = Math.min(v.maxLevel, Number.isInteger(m.maxLevel) ? m.maxLevel : v.maxLevel, LADDER.length - 1);
    // A refresh or reconnect resumes at the level this session had earned instead of starting high, falling to saver, and climbing again.
    const mem = this._levels.get(c.session.idHash);
    const start = Number.isInteger(m.level) ? m.level : (mem && Date.now() - mem.t < 10 * 60_000 ? mem.level : v.defaultLevel);
    c.q = new QualityController({ minLevel: 0, maxLevel, level: Math.min(maxLevel, start), auto, jpeg });
    c.attached = true;
    this._startHelper(c);
    this._send(c, { t: 'attached', codec: jpeg ? 'jpeg' : 'h264', params: c.q.params(), ladder: LADDER });
  }

  _qualityPref(c, m) {
    if (!c.q) return;
    if (typeof m.auto === 'boolean') c.q.auto = m.auto;
    if (Number.isInteger(m.maxLevel)) c.q.maxLevel = Math.min(this.config.video.maxLevel, Math.max(0, m.maxLevel));
    if (Number.isInteger(m.level)) c.q.level = Math.min(c.q.maxLevel, Math.max(0, m.level));
    if (c.q.level > c.q.maxLevel) c.q.level = c.q.maxLevel;
    this.helper.send({ c: 'quality', ...c.q.params() });
    this._send(c, { t: 'qstats', ...c.q.stats(), params: c.q.params(), auto: c.q.auto, maxLevel: c.q.maxLevel });
  }

  _clip(c, m) {
    if (!this.config.clipboard.sync) return;
    const out = { c: 'clipset' };
    if (typeof m.text === 'string' && m.text.length <= 4 * 1024 * 1024) out.text = m.text;
    if (typeof m.png === 'string' && m.png.length <= 16 * 1024 * 1024) out.png = m.png;
    if (out.text !== undefined || out.png !== undefined) this.helper.send(out);
  }

  /** Validates and forwards input events. Returns true if the message was an input event. */
  _input(c, m) {
    if (this._pend && ['mm', 'mb', 'wh', 'kd', 'ku', 'txt', 'seq', 'rel'].includes(m.t)) {
      // a paced key sequence is in flight: keep strict ordering behind it
      if (this._pend.length < 500) this._pend.push(m);
      return true;
    }
    return this._exec(m);
  }

  _exec(m) {
    const h = this.helper;
    switch (m.t) {
      case 'mm': h.send({ c: 'mm', x: num(m.x, 0, 1), y: num(m.y, 0, 1) }); return true;
      case 'mb': h.send({ c: 'mb', b: [0, 1, 2].includes(m.b) ? m.b : 0, d: !!m.d, x: num(m.x, 0, 1), y: num(m.y, 0, 1), n: Math.round(num(m.n, 1, 3, 1)) }); return true;
      case 'wh': h.send({ c: 'wh', dx: num(m.dx, -3000, 3000), dy: num(m.dy, -3000, 3000) }); return true;
      case 'kd': if (typeof m.k === 'string' && KEY_RE.test(m.k)) h.send({ c: 'kd', k: m.k, r: !!m.r }); return true;
      case 'ku': if (typeof m.k === 'string' && KEY_RE.test(m.k)) h.send({ c: 'ku', k: m.k }); return true;
      case 'txt': if (typeof m.s === 'string') h.send({ c: 'txt', s: m.s.slice(0, 20000) }); return true;
      case 'rel': h.send({ c: 'rel' }); return true;
      case 'seq': this._seq(m.ops); return true;
      default: return false;
    }
  }

  _cancelSeq() { this._seqGen++; this._pend = null; }

  /** ops: [{k:'MetaLeft', d:true}, ...] executed in order with a tiny gap so apps see distinct events. */
  _seq(ops) {
    if (!Array.isArray(ops)) return;
    const list = ops.slice(0, 40).filter((o) => o && typeof o.k === 'string' && KEY_RE.test(o.k));
    if (!list.length) return;
    let i = 0;
    const gen = ++this._seqGen;
    this._pend = [];
    const step = () => {
      if (gen !== this._seqGen) return;     // cancelled by _cancelSeq
      if (i >= list.length) {
        const rest = this._pend; this._pend = null;
        for (const m of rest) this._input(null, m);
        return;
      }
      const o = list[i++];
      this.helper.send({ c: o.d ? 'kd' : 'ku', k: o.k });
      setTimeout(step, 6);
    };
    step();
  }
}

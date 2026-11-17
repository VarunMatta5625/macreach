/** Adaptive quality controller. One instance per attached client.
 *  Inputs: frames sent (seq, bytes), acks from the client (seq). Output: quality level decisions + drop gating.
 *  Principle: latency beats smoothness. Never queue; when the path is saturated, drop to next keyframe and step down. */

export const LADDER = [
  { name: 'saver',   maxW: 960,  maxH: 600,  fps: 15, bitrate: 900_000 },
  { name: 'low',     maxW: 1280, maxH: 800,  fps: 24, bitrate: 2_000_000 },
  { name: 'medium',  maxW: 1600, maxH: 1000, fps: 30, bitrate: 3_500_000 },
  { name: '1080p',   maxW: 1920, maxH: 1200, fps: 30, bitrate: 6_000_000 },
  { name: '1080p60', maxW: 1920, maxH: 1200, fps: 60, bitrate: 10_000_000 },
  { name: 'native',  maxW: 0,    maxH: 0,    fps: 60, bitrate: 16_000_000 },
];

const MIN_INFLIGHT_FRAMES = 4, MAX_INFLIGHT_FRAMES = 20;   // 20: a 400 ms relay path at 30 fps legitimately has ~12 frames in flight

export class QualityController {
  constructor({ minLevel = 0, maxLevel = LADDER.length - 1, level = 3, auto = true, jpeg = false } = {}) {
    this.minLevel = minLevel; this.maxLevel = maxLevel; this.level = Math.min(maxLevel, Math.max(minLevel, level));
    this.auto = auto; this.jpeg = jpeg;
    this.sent = new Map();       // seq -> { t, bytes }
    this.inflightBytes = 0;
    this.rttMin = Infinity; this.rtt = 0;
    this.drops = 0; this.dropsWindow = [];
    this.ackedBytes = []; // [t, bytes]
    this.sentBytes = [];
    this.lastChange = Date.now();
    this.lastCongestion = 0;
    this.waitKey = false;        // dropped a P-frame: discard until next keyframe
    this.lastKeyReq = 0;
    this.lastUp = 0;             // when we last climbed
    this.climbWait = 6000;       // how long the link must be calm before climbing; doubles when a climb is punished
  }

  params() {
    const l = LADDER[this.level];
    if (this.jpeg) return { codec: 'jpeg', maxW: l.maxW, maxH: l.maxH, fps: Math.min(l.fps, 20), bitrate: l.bitrate, jpegQ: Math.min(0.85, Math.max(0.35, 0.3 + this.level * 0.1)) };
    return { codec: 'h264', maxW: l.maxW, maxH: l.maxH, fps: l.fps, bitrate: l.bitrate };
  }

  /** Decide whether to forward a frame. Returns { send, needKeyframe }. */
  gate(key, bytes, now = Date.now()) {
    if (this.waitKey && !key) return { send: false, needKeyframe: this._wantKey(now) };
    if (key) this.waitKey = false;
    const over = this.sent.size >= this._maxInflight() || this.inflightBytes > this._byteBudget();
    if (over && !key) {
      this.drops++; this.dropsWindow.push(now);
      if (!this.jpeg) this.waitKey = true;
      this.lastCongestion = now;
      return { send: false, needKeyframe: this.jpeg ? false : this._wantKey(now) };
    }
    return { send: true, needKeyframe: false };
  }

  /** Frames legitimately in flight = frame rate x path delay. A fixed 4 is fine on a LAN but reads a 150 ms phone path as congestion. */
  _maxInflight() {
    const fps = Math.min(LADDER[this.level].fps, this.jpeg ? 20 : 60);
    const delay = this.rttMin < Infinity ? this.rttMin / 1000 : 0.1;
    return Math.max(MIN_INFLIGHT_FRAMES, Math.min(MAX_INFLIGHT_FRAMES, Math.ceil(fps * delay * 1.5) + 3));
  }

  /** A keyframe is several times a delta frame. Asking for one while the path is still draining the burst that caused the drop just
   *  refills the queue, so wait until about half the budget has cleared. */
  _wantKey(now) {
    if (now - this.lastKeyReq <= 400 || this.inflightBytes > this._byteBudget() * 0.5) return false;
    this.lastKeyReq = now; return true;
  }

  /** Bytes allowed in flight. Bounded by time, not size: what the path has actually been carrying (acked rate) times one round trip
   *  plus ~150 ms of slack. A fixed size lets a burst sit in a slow relay's queue for a second or more, and every mouse move
   *  then shows up that much later. Falls back to a bitrate-based figure until acks have established a rate. */
  _byteBudget() {
    const l = LADDER[this.level];
    const ceiling = Math.max(256 * 1024, (l.bitrate / 8) * 0.25);
    const ackRate = this.ackedBytes.reduce((a, [, b]) => a + b, 0) / 3;   // B/s over the last 3 s
    if (this.rttMin === Infinity || ackRate <= 0) return ceiling;
    const rate = Math.max(ackRate, (l.bitrate / 8) * 0.25);               // never starve a screen that just started moving
    return Math.min(ceiling, Math.max(64 * 1024, rate * (this.rttMin / 1000 + 0.15)));
  }

  onSent(seq, bytes, now = Date.now()) {
    this.sent.set(seq, { t: now, bytes });
    this.inflightBytes += bytes;
    this.sentBytes.push([now, bytes]);
    if (this.sent.size > 200) { const first = this.sent.keys().next().value; const e = this.sent.get(first); this.inflightBytes -= e.bytes; this.sent.delete(first); }
  }

  onAck(seq, now = Date.now()) {
    const e = this.sent.get(seq);
    if (!e) return;
    // acks are cumulative: retire everything up to and including seq (Map iterates in ascending seq order)
    for (const [s, v] of this.sent) {
      if (s > seq) break;
      this.inflightBytes -= v.bytes; this.sent.delete(s); this.ackedBytes.push([now, v.bytes]);
    }
    const rtt = now - e.t;
    this.rtt = this.rtt ? this.rtt * 0.8 + rtt * 0.2 : rtt;
    if (rtt < this.rttMin) this.rttMin = rtt; else this.rttMin = this.rttMin * 0.999 + rtt * 0.001; // slowly forget
  }

  /** Called every ~500ms. Returns new params if level changed, else null. */
  tick(now = Date.now()) {
    const trim = (a, ms) => { while (a.length && now - a[0][0] > ms) a.shift(); };
    trim(this.ackedBytes, 3000); trim(this.sentBytes, 3000);
    while (this.dropsWindow.length && now - this.dropsWindow[0] > 2000) this.dropsWindow.shift();
    // stale in-flight (lost acks / stalled client): flush
    for (const [s, v] of this.sent) if (now - v.t > 3000) { this.inflightBytes -= v.bytes; this.sent.delete(s); this.lastCongestion = now; }
    if (!this.auto) return null;
    const congested = this.dropsWindow.length >= 2 ||
      (this.rttMin < Infinity && this.rtt > this.rttMin * 2 + 80 && this.sent.size >= 2);
    if (congested) this.lastCongestion = now;
    if (congested && this.level > this.minLevel && now - this.lastChange > 800) {
      if (now - this.lastUp < 15000) this.climbWait = Math.min(120000, this.climbWait * 2);   // the last climb didn't hold: be more careful
      this.level--; this.lastChange = now; this.dropsWindow.length = 0; this.drops = 0;
      return this.params();
    }
    const quiet = (ms) => now - this.lastCongestion > ms && now - this.lastChange > ms;
    const sentRate = this.sentBytes.reduce((a, [, b]) => a + b, 0) / 3; // B/s
    const target = LADDER[this.level].bitrate / 8;
    // Climb when the stream is using its budget (proof the link carries it), or, on a mostly static screen where that
    // proof never comes, after a longer calm spell. A static screen would otherwise stay at 'saver' (blurry) forever.
    const proven = quiet(this.climbWait) && sentRate > target * 0.5;
    // The two lowest rungs are cheap and where a laggy path (Funnel, ~400 ms) spends its time: probe them sooner. A punished climb
    // still doubles climbWait, so a link that really cannot carry the next rung backs off exponentially.
    const idleWait = Math.max(this.level <= 1 ? 8000 : 15000, this.climbWait);
    const idleClimb = quiet(idleWait) && this.rtt > 0 && sentRate <= target * 0.5;
    if (this.level < this.maxLevel && (proven || idleClimb)) {
      this.level++; this.lastChange = now; this.lastUp = now;
      return this.params();
    }
    return null;
  }

  stats() {
    const l = LADDER[this.level];
    const sum = (a) => a.reduce((x, [, b]) => x + b, 0) * 8 / 3;
    return { level: this.level, name: l.name, rtt: Math.round(this.rtt), inflight: this.sent.size, drops: this.drops, sendBps: Math.round(sum(this.sentBytes)), ackBps: Math.round(sum(this.ackedBytes)) };
  }
}

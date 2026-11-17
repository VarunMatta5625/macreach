import { CFG } from './config.js';

const TERMINAL = new Set([4001, 4002, 4003, 4004, 4005]);

/** WebSocket transport: JSON control text frames + binary video frames. Auto-reconnect with backoff. */
export class Net extends EventTarget {
  constructor() {
    super();
    this.ws = null; this.open = false; this.closedForGood = false;
    this.attempt = 0; this.rtt = 0; this.rttAvg = 0; this.onVideo = null; this._pingN = 0; this._pings = new Map();
    this._pingTimer = null;
  }
  connect() {
    this.closedForGood = false;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.open = true; this.attempt = 0;
      this.dispatchEvent(new Event('open'));
      clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => this._ping(), CFG.net.pingMs);
      this._ping();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { this.onVideo?.(ev.data); return; }
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'pong') { const t0 = this._pings.get(m.n); if (t0) { this.rtt = performance.now() - t0; this.rttAvg = this.rttAvg ? this.rttAvg * 0.7 + this.rtt * 0.3 : this.rtt; this._pings.delete(m.n); } return; }
      this.dispatchEvent(new CustomEvent('msg', { detail: m }));
    };
    ws.onclose = (ev) => {
      const wasOpen = this.open;
      this.open = false; clearInterval(this._pingTimer);
      if (this.ws === ws) this.ws = null;
      if (TERMINAL.has(ev.code)) this.closedForGood = true;
      this.dispatchEvent(new CustomEvent('close', { detail: { code: ev.code, wasOpen, final: this.closedForGood } }));
      if (!this.closedForGood) {
        const d = Math.min(CFG.net.reconnectMaxMs, CFG.net.reconnectBaseMs * 2 ** this.attempt++);
        setTimeout(() => { if (!this.closedForGood && !this.ws) this.connect(); }, d);
      }
    };
    ws.onerror = () => {};
  }
  _ping() { const n = ++this._pingN; this._pings.set(n, performance.now()); if (this._pings.size > 20) this._pings.clear(); this.send({ t: 'ping', n }); }
  send(o) { if (this.open && this.ws?.readyState === 1) { this.ws.send(JSON.stringify(o)); return true; } return false; }
  close() { this.closedForGood = true; try { this.ws?.close(); } catch {} }
}

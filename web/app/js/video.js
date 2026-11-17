import { CFG } from './config.js';

const H264_PROBES = ['avc1.640032', 'avc1.64002a', 'avc1.42e01f'];

/** Decodes the stream into a canvas. WebCodecs H.264 when available, JPEG (createImageBitmap) otherwise.
 *  Latency policy: decode everything in order, render only the newest frame, never queue. */
export class Video extends EventTarget {
  constructor(canvas, net) {
    super();
    this.canvas = canvas; this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.net = net;
    this.decoder = null; this.cfg = null; this.needKey = true;
    this.pending = null;          // newest decoded VideoFrame / ImageBitmap awaiting paint
    this.raf = 0; this.kind = null;
    this.jpegBusy = false; this.jpegNext = null;
    this.stats = { frames: 0, bytes: 0, decodeMs: 0, fps: 0, bps: 0, dropped: 0, lastT: performance.now() };
    this.lastAck = 0;
    this.w = 0; this.h = 0;
    setInterval(() => this._statsTick(), CFG.video.statsMs);
  }

  static async probe() {
    if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') return { h264: false };
    for (const codec of H264_PROBES) {
      try {
        const r = await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080, optimizeForLatency: true });
        if (r.supported) return { h264: true, codec };
      } catch {}
    }
    return { h264: false };
  }

  configure(cfg, force = false) {
    // The helper repeats videoConfig with every keyframe. Tearing the decoder down for an identical config starves
    // hardware decoders (Android) that need a few hundred ms to produce their first frame, so they never output anything.
    const sig = `${cfg.codec}|${cfg.w}|${cfg.h}|${cfg.desc || ''}`;
    if (!force && sig === this._sig && (cfg.codec === 'jpeg' ? this.kind === 'jpeg' : this.decoder?.state === 'configured')) { this.cfg = cfg; return; }
    this._sig = sig;
    this.cfg = cfg; this.needKey = true;
    const w = cfg.w, h = cfg.h;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.w = w; this.h = h;
    if (cfg.codec === 'jpeg') { this.kind = 'jpeg'; this._closeDecoder(); }
    else {
      this.kind = 'h264';
      this._closeDecoder();
      const desc = Uint8Array.from(atob(cfg.desc), (c) => c.charCodeAt(0));
      this.decoder = new VideoDecoder({
        output: (frame) => this._onDecoded(frame),
        error: (e) => { console.warn('decoder error', e); this._recover(); },
      });
      try {
        this.decoder.configure({ codec: cfg.codec, codedWidth: w, codedHeight: h, description: desc, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
      } catch (e) { console.warn('configure failed', e); this.dispatchEvent(new CustomEvent('fatal', { detail: 'decoder' })); }
    }
    this.dispatchEvent(new CustomEvent('resize', { detail: { w, h } }));
  }

  _closeDecoder() { try { this.decoder?.close(); } catch {} this.decoder = null; }
  _recover() { this.needKey = true; if (this.cfg) this.configure(this.cfg, true); this.net.send({ t: 'keyframe' }); }

  /** ArrayBuffer: [flags 1][seq 4][ts 8][payload] */
  onFrame(buf) {
    if (buf.byteLength < 14) return;
    const dv = new DataView(buf);
    const flags = dv.getUint8(0), seq = dv.getUint32(1);
    const data = new Uint8Array(buf, 13);
    this.stats.bytes += buf.byteLength;
    const key = (flags & 1) !== 0;
    if (flags & 2) return this._jpeg(seq, data);
    if (this.kind !== 'h264' || !this.decoder || this.decoder.state !== 'configured') return;
    if (this.needKey) { if (!key) return; this.needKey = false; }
    if (this.decoder.decodeQueueSize > CFG.video.maxDecodeQueue) { // decoder can't keep up: resync at next keyframe
      this.needKey = true; this.stats.dropped++; this.net.send({ t: 'keyframe' }); return;
    }
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: seq, data }));
      this._t0 = this._t0 || new Map(); this._t0.set(seq, performance.now());
      if (this._t0.size > 60) this._t0.delete(this._t0.keys().next().value);
    } catch (e) { console.warn('decode failed', e); this._recover(); }
  }

  _onDecoded(frame) {
    const seq = frame.timestamp;
    const t0 = this._t0?.get(seq);
    if (t0) { this.stats.decodeMs = this.stats.decodeMs * 0.9 + (performance.now() - t0) * 0.1; this._t0.delete(seq); }
    this._ack(seq);
    if (this.pending) { try { this.pending.close?.(); } catch {} this.stats.dropped++; }
    this.pending = frame;
    this._schedule();
  }

  async _jpeg(seq, data) {
    if (this.jpegBusy) { this.jpegNext = { seq, data: data.slice() }; return; }
    this.jpegBusy = true;
    try {
      const bmp = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }));
      this._ack(seq);
      if (this.pending) { try { this.pending.close?.(); } catch {} }
      this.pending = bmp; this._schedule();
    } catch {}
    this.jpegBusy = false;
    if (this.jpegNext) { const n = this.jpegNext; this.jpegNext = null; this._jpeg(n.seq, n.data); }
  }

  _ack(seq) { this.net.send({ t: 'ack', seq }); }

  _schedule() { if (!this.raf) this.raf = requestAnimationFrame(() => this._paint()); }
  _paint() {
    this.raf = 0;
    const f = this.pending; if (!f) return;
    this.pending = null;
    try {
      const fw = f.displayWidth || f.width, fh = f.displayHeight || f.height;
      if (fw && fh && (fw !== this.canvas.width || fh !== this.canvas.height)) { this.canvas.width = fw; this.canvas.height = fh; this.w = fw; this.h = fh; this.dispatchEvent(new CustomEvent('resize', { detail: { w: fw, h: fh } })); }
      this.ctx.drawImage(f, 0, 0);
      this.stats.frames++;
      if (!this.firstPainted) { this.firstPainted = true; this.dispatchEvent(new Event('first')); }
    } catch {}
    try { f.close?.(); } catch {}
  }

  reset() { this.needKey = true; this.firstPainted = false; this._closeDecoder(); this.kind = null; this._sig = null; }

  _statsTick() {
    const now = performance.now(), dt = (now - this.stats.lastT) / 1000; this.stats.lastT = now;
    this.stats.fps = Math.round(this.stats.frames / dt); this.stats.bps = Math.round(this.stats.bytes * 8 / dt);
    this.stats.frames = 0; this.stats.bytes = 0;
    this.dispatchEvent(new Event('stats'));
  }
}

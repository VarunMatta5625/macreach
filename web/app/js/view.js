import { CFG } from './config.js';

/** Maps between client coordinates and Mac-screen coordinates; handles fit / zoom / pan of the canvas. */
export class View extends EventTarget {
  constructor(stage, canvas) {
    super();
    this.stage = stage; this.canvas = canvas;
    this.vw = 1920; this.vh = 1080;
    this.zoom = 1; this.tx = 0; this.ty = 0;
    this.L = 0; this.T = 0; this.bw = 1; this.bh = 1;
    new ResizeObserver(() => this.layout()).observe(stage);
  }
  setVideoSize(w, h) { this.vw = w; this.vh = h; this.layout(); }
  layout() {
    const sr = this.stage.getBoundingClientRect();
    const sw = sr.width, sh = sr.height;
    if (!sw || !sh) return;
    const s = Math.min(sw / this.vw, sh / this.vh);
    this.bw = this.vw * s; this.bh = this.vh * s;
    this.L = (sw - this.bw) / 2; this.T = (sh - this.bh) / 2;
    const c = this.canvas.style;
    c.width = this.bw + 'px'; c.height = this.bh + 'px'; c.left = this.L + 'px'; c.top = this.T + 'px';
    this._clamp(); this._apply();
  }
  _clamp() {
    const sr = this.stage.getBoundingClientRect();
    const cw = this.bw * this.zoom, ch = this.bh * this.zoom;
    let left = this.L + this.tx, top = this.T + this.ty;
    left = cw <= sr.width ? (sr.width - cw) / 2 : Math.min(0, Math.max(sr.width - cw, left));
    top = ch <= sr.height ? (sr.height - ch) / 2 : Math.min(0, Math.max(sr.height - ch, top));
    this.tx = left - this.L; this.ty = top - this.T;
  }
  _apply() {
    this.canvas.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.zoom})`;
    this.dispatchEvent(new Event('change'));
  }
  reset() { this.zoom = 1; this.tx = 0; this.ty = 0; this.layout(); }
  zoomAt(cx, cy, z) {
    z = Math.min(CFG.touch.zoom.max, Math.max(CFG.touch.zoom.min, z));
    const sr = this.stage.getBoundingClientRect();
    const u = (cx - sr.left - this.L - this.tx) / this.zoom, v = (cy - sr.top - this.T - this.ty) / this.zoom;
    this.zoom = z;
    this.tx = cx - sr.left - this.L - z * u; this.ty = cy - sr.top - this.T - z * v;
    this._clamp(); this._apply();
  }
  panBy(dx, dy) { this.tx += dx; this.ty += dy; this._clamp(); this._apply(); }
  /** Keep a normalized point comfortably inside the visible area (used by trackpad mode when zoomed). */
  follow(nx, ny, marginPx = 60) {
    if (this.zoom <= 1.001) return;
    const sr = this.stage.getBoundingClientRect();
    const px = sr.left + this.L + this.tx + nx * this.bw * this.zoom, py = sr.top + this.T + this.ty + ny * this.bh * this.zoom;
    let dx = 0, dy = 0;
    if (px < sr.left + marginPx) dx = sr.left + marginPx - px; else if (px > sr.right - marginPx) dx = sr.right - marginPx - px;
    if (py < sr.top + marginPx) dy = sr.top + marginPx - py; else if (py > sr.bottom - marginPx) dy = sr.bottom - marginPx - py;
    if (dx || dy) this.panBy(dx, dy);
  }
  /** client px -> normalized [0,1] position on the Mac screen (clamped). */
  toNorm(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (cx - r.left) / r.width)), y: Math.min(1, Math.max(0, (cy - r.top) / r.height)) };
  }
  /** normalized -> client px */
  toClient(nx, ny) {
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + nx * r.width, y: r.top + ny * r.height };
  }
  /** Mac pixels per client px at the current zoom (for scroll scaling). */
  get scale() { return this.canvas.getBoundingClientRect().width / this.bw; }
}

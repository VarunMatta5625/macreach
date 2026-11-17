import { CFG } from './config.js';

const hypot = Math.hypot;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Sub-pixel accumulation so slow scrolls aren't lost to integer rounding on the Mac side. */
class ScrollSender {
  constructor(send) { this.send = send; this.ax = 0; this.ay = 0; }
  push(dx, dy) {
    this.ax += dx; this.ay += dy;
    const ix = Math.trunc(this.ax), iy = Math.trunc(this.ay);
    if (ix || iy) { this.ax -= ix; this.ay -= iy; this.send({ t: 'wh', dx: ix, dy: iy }); }
  }
}

/** Pointer input: desktop mouse/trackpad, Apple Pencil / pen, and touch (direct + trackpad modes). */
export class InputController {
  constructor({ stage, view, net, settings, ui, marker, ring }) {
    this.stage = stage; this.view = view; this.net = net; this.settings = settings; this.ui = ui;
    this.marker = marker; this.ring = ring;
    this.enabled = false;
    this.oneShot = null;                 // 'right' | 'middle' | null  (toolbar: next tap uses this button)
    this.dragLock = false;               // toolbar: keep left button held
    this.cursor = { x: 0.5, y: 0.5 };    // virtual cursor (trackpad mode) / last pointer (others), normalized
    this.scroller = new ScrollSender((m) => this._send(m));
    this.pending = null; this.raf = 0;   // coalesced mouse moves
    this.buttonsDown = new Set();
    this.lastClick = { t: 0, x: 0, y: 0, n: 0, b: 0 };   // for desktop multi-click counting
    this.pointers = new Map();           // touch pointers
    this.g = null;                       // current touch gesture
    this.ignoreUntilEmpty = false;
    this.lastTap = { t: 0, x: 0, y: 0, n: 0 };
    this.mom = null;
    this.wheelAcc = null;
    this._bind();
    view.addEventListener('change', () => this._placeMarker());
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) { this.cancelAll(); }
  }

  _send(m) { if (this.enabled) this.net.send(m); }

  cancelAll() {
    this._stopMomentum();
    clearTimeout(this.g?.timer);
    this.g = null; this.pointers.clear(); this.ignoreUntilEmpty = false;
    if (this.buttonsDown.size) { this.net.send({ t: 'rel' }); this.buttonsDown.clear(); }
    this.dragLock = false;
  }

  // ---------- helpers ----------
  _moveNow(x, y) { this.cursor = { x, y }; this.pending = { x, y }; if (!this.raf) this.raf = requestAnimationFrame(() => this._flushMove()); this._placeMarker(); }
  _flushMove() { this.raf = 0; if (this.pending) { this._send({ t: 'mm', x: this.pending.x, y: this.pending.y }); this.pending = null; } }
  _flushPendingMove() { if (this.pending) { cancelAnimationFrame(this.raf); this.raf = 0; this._flushMove(); } }

  _btn(b, down, x, y, n = 1) {
    this._flushPendingMove();
    this.cursor = { x, y };
    if (down) this.buttonsDown.add(b); else this.buttonsDown.delete(b);
    this._send({ t: 'mb', b, d: down, x, y, n });
    this._placeMarker();
    if (!down) this.ui?.afterClick?.();
  }

  _click(b, x, y, n = 1) { this._btn(b, true, x, y, n); this._btn(b, false, x, y, n); }

  _haptic() { try { navigator.vibrate?.(CFG.ui.hapticMs); } catch {} }

  _placeMarker() {
    const m = this.marker; if (!m) return;
    const show = this.enabled && this.settings.get('touchMode') === 'trackpad' && this._lastWasTouch;
    m.hidden = !show; if (!show) return;
    const p = this.view.toClient(this.cursor.x, this.cursor.y), sr = this.stage.getBoundingClientRect();
    m.style.transform = `translate(${p.x - sr.left}px, ${p.y - sr.top}px)`;
  }

  _ring(x, y) {
    const r = this.ring; if (!r) return;
    const sr = this.stage.getBoundingClientRect();
    r.style.transform = `translate(${x - sr.left}px, ${y - sr.top}px)`;
    r.classList.remove('go'); void r.offsetWidth; r.classList.add('go');
  }

  _consumeOneShot() { const b = this.oneShot; this.oneShot = null; this.ui?.oneShotChanged?.(null); return b; }

  // ---------- event wiring ----------
  _bind() {
    const s = this.stage;
    s.addEventListener('contextmenu', (e) => e.preventDefault());
    s.addEventListener('pointerdown', (e) => this._down(e));
    s.addEventListener('pointermove', (e) => this._move(e));
    s.addEventListener('pointerup', (e) => this._up(e));
    s.addEventListener('pointercancel', (e) => this._up(e, true));
    s.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !this.buttonsDown.size) { /* keep last position */ } });
    s.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    // iOS Safari pinch-zoom of the page itself
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) s.addEventListener(t, (e) => e.preventDefault(), { passive: false });
    s.addEventListener('dblclick', (e) => e.preventDefault());
    s.addEventListener('dragstart', (e) => e.preventDefault());
  }

  _down(e) {
    if (!this.enabled) return;
    if (e.pointerType === 'touch') { this._lastWasTouch = true; return this._touchDown(e); }
    this._lastWasTouch = false; this._placeMarker();
    // mouse / pen: absolute
    e.preventDefault();
    try { this.stage.setPointerCapture(e.pointerId); } catch {}
    const n = this.view.toNorm(e.clientX, e.clientY);
    let b = e.button === 2 ? 1 : e.button === 1 ? 2 : 0;
    if (e.pointerType === 'pen' && (e.buttons & 2 || e.button === 2)) b = 1;
    if (this.oneShot && b === 0) { b = this.oneShot === 'right' ? 1 : 2; this._consumeOneShot(); }
    const now = performance.now(), lc = this.lastClick, M = CFG.mouse;
    const near = hypot(e.clientX - lc.x, e.clientY - lc.y) <= M.multiClickSlopPx;
    const n_ = (now - lc.t < M.multiClickMs && near && lc.b === b) ? Math.min(3, lc.n + 1) : 1;
    this.lastClick = { t: now, x: e.clientX, y: e.clientY, n: n_, b };
    this._btn(b, true, n.x, n.y, n_);
  }

  _move(e) {
    if (!this.enabled) return;
    if (e.pointerType === 'touch') return this._touchMove(e);
    this._lastWasTouch = false;
    // mouse move / pen hover / pen drag. Use coalesced-free latest position, flushed once per frame.
    const n = this.view.toNorm(e.clientX, e.clientY);
    this._moveNow(n.x, n.y);
  }

  _up(e, cancel = false) {
    if (!this.enabled) { return; }
    if (e.pointerType === 'touch') return this._touchUp(e, cancel);
    e.preventDefault();
    const n = this.view.toNorm(e.clientX, e.clientY);
    let b = e.button === 2 ? 1 : e.button === 1 ? 2 : 0;
    // buttons may have been remapped (one-shot / pen): release whatever is down
    const down = [...this.buttonsDown];
    if (down.length && !down.includes(b)) b = down[0];
    if (this.buttonsDown.has(b)) {
      if (b === 0 && this.dragLock) return;
      this._btn(b, false, n.x, n.y, this.lastClick.n || 1);
    }
  }

  // ---------- wheel / trackpad two-finger scroll / pinch (desktop) ----------
  _wheel(e) {
    e.preventDefault();
    if (!this.enabled) return;
    if (e.ctrlKey) { // trackpad pinch (and Ctrl+wheel) zooms the local view, not the Mac
      const f = Math.exp(-e.deltaY * 0.01);
      this.view.zoomAt(e.clientX, e.clientY, this.view.zoom * f);
      return;
    }
    const M = CFG.mouse;
    const k = e.deltaMode === 1 ? M.wheelLinePx : e.deltaMode === 2 ? M.wheelPagePx : 1;
    let dx = e.deltaX * k * M.wheelGain, dy = e.deltaY * k * M.wheelGain;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; } // shift+wheel = horizontal (mouse users)
    const n = this.view.toNorm(e.clientX, e.clientY);
    this._moveNow(n.x, n.y);
    this.scroller.push(dx, dy);
  }

  // ---------- touch ----------
  _mode() { return this.settings.get('touchMode'); }

  _touchDown(e) {
    e.preventDefault();
    try { this.stage.setPointerCapture(e.pointerId); } catch {}
    this.pointers.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });
    this._stopMomentum();
    const n = this.pointers.size;
    if (this.ignoreUntilEmpty) return;
    if (n === 1) this._startOne(this.pointers.get(e.pointerId));
    else if (n === 2) this._startTwo();
    else { this._abortGesture(); this.ignoreUntilEmpty = true; } // 3+ fingers are reserved by iPadOS; ignore
  }

  _touchMove(e) {
    const p = this.pointers.get(e.pointerId); if (!p) return;
    e.preventDefault();
    p.px = p.x; p.py = p.y; p.x = e.clientX; p.y = e.clientY;
    if (this.ignoreUntilEmpty || !this.g) return;
    if (this.g.kind === 'one') this._moveOne(p, e);
    else if (this.g.kind === 'two') this._moveTwo();
  }

  _touchUp(e, cancel) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    p.x = e.clientX; p.y = e.clientY;
    const g = this.g;
    if (!this.ignoreUntilEmpty && g) {
      if (g.kind === 'one') this._endOne(p, cancel);
      else if (g.kind === 'two') { this._endTwo(cancel); this.ignoreUntilEmpty = true; }
    }
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) { this.ignoreUntilEmpty = false; if (this.g && this.g.kind !== 'one') this.g = null; }
  }

  _abortGesture() {
    const g = this.g; if (!g) return;
    clearTimeout(g.timer);
    if (g.dragging) { this._btn(0, false, this.cursor.x, this.cursor.y); }
    this.g = null;
  }

  // --- one finger ---
  _startOne(p) {
    const now = performance.now();
    const mode = this._mode();
    const g = this.g = { kind: 'one', p, sx: p.x, sy: p.y, t0: now, moved: false, lp: false, dragging: false, pan: false, lx: p.x, ly: p.y, lt: now, mode, tapDrag: false };
    if (mode === 'trackpad') {
      g.tapDrag = (now - this.lastTap.t) < CFG.touch.trackpad.tapDragWindowMs && this.lastTap.n >= 1;
    } else {
      g.timer = setTimeout(() => {
        if (this.g !== g || g.moved) return;
        g.lp = true; this._haptic(); this._ring(g.sx, g.sy);
        const n = this.view.toNorm(g.sx, g.sy); this._moveNow(n.x, n.y);
      }, CFG.touch.longPressMs);
    }
  }

  _moveOne(p) {
    const g = this.g, T = CFG.touch;
    const now = performance.now();
    const dist = hypot(p.x - g.sx, p.y - g.sy);
    const dx = p.x - g.lx, dy = p.y - g.ly, dt = Math.max(1, now - g.lt);
    g.lx = p.x; g.ly = p.y; g.lt = now;

    if (g.mode === 'trackpad') {
      if (!g.moved && dist > T.tapSlopPx) g.moved = true;
      if (g.tapDrag && !g.dragging && dist > T.dragSlopPx) {
        g.dragging = true; this._btn(0, true, this.cursor.x, this.cursor.y, 1); this._haptic();
      }
      if (g.moved || g.dragging) this._trackpadMove(dx, dy, dt);
      return;
    }
    // direct mode
    if (g.dragging) { const n = this.view.toNorm(p.x, p.y); this._moveNow(n.x, n.y); return; }
    if (g.lp) {
      if (dist > T.dragSlopPx) {
        g.dragging = true; g.moved = true;
        const s = this.view.toNorm(g.sx, g.sy);
        this._btn(0, true, s.x, s.y, 1);
        const n = this.view.toNorm(p.x, p.y); this._moveNow(n.x, n.y);
      }
      return;
    }
    if (!g.moved && dist > T.tapSlopPx) { g.moved = true; clearTimeout(g.timer); g.pan = this.view.zoom > 1.001; }
    if (g.moved) {
      if (g.pan) this.view.panBy(dx, dy);
      else { const n = this.view.toNorm(p.x, p.y); this._moveNow(n.x, n.y); } // hover-follow
    }
  }

  _trackpadMove(dx, dy, dt) {
    const T = CFG.touch.trackpad;
    const speed = hypot(dx, dy) / dt;                       // px/ms
    const gain = Math.min(T.maxGain, T.baseGain + T.accel * speed);
    const r = this.view.canvas.getBoundingClientRect();
    const nx = clamp(this.cursor.x + (dx * gain) / r.width, 0, 1), ny = clamp(this.cursor.y + (dy * gain) / r.height, 0, 1);
    this._moveNow(nx, ny);
    this.view.follow(nx, ny);
  }

  _endOne(p, cancel) {
    const g = this.g, T = CFG.touch;
    clearTimeout(g.timer);
    const now = performance.now(), dur = now - g.t0;
    this.g = null;
    if (g.dragging) { const n = g.mode === 'trackpad' ? this.cursor : this.view.toNorm(p.x, p.y); if (!this.dragLock) this._btn(0, false, n.x, n.y); return; }
    if (cancel) return;
    const direct = g.mode !== 'trackpad';
    const pos = direct ? this.view.toNorm(p.x, p.y) : this.cursor;
    if (direct && g.lp && !g.moved) { this._click(1, pos.x, pos.y); this._lastTapReset(); return; } // long-press release = right click
    if (g.moved || dur > T.tapMaxMs) return;
    // tap
    let b = 0;
    if (this.oneShot) b = this.oneShot === 'right' ? 1 : 2, this._consumeOneShot();
    let n = 1;
    const lt = this.lastTap;
    if (b === 0 && now - lt.t < T.doubleTapMs && hypot(p.x - lt.x, p.y - lt.y) < T.doubleTapSlopPx) n = Math.min(3, lt.n + 1);
    if (direct) this._moveNow(pos.x, pos.y);
    this._click(b, pos.x, pos.y, n);
    this.lastTap = { t: now, x: p.x, y: p.y, n: b === 0 ? n : 0 };
  }
  _lastTapReset() { this.lastTap = { t: 0, x: 0, y: 0, n: 0 }; }

  // --- two fingers ---
  _startTwo() {
    this._abortGesture();
    const [a, b] = [...this.pointers.values()];
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d = hypot(a.x - b.x, a.y - b.y) || 1;
    this.g = { kind: 'two', t0: performance.now(), c0: c, lc: c, d0: d, ld: d, intent: null, tapOk: true, samples: [], ax: 0 };
  }

  _moveTwo() {
    const g = this.g, T = CFG.touch;
    const pts = [...this.pointers.values()]; if (pts.length < 2) return;
    const [a, b] = pts;
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d = hypot(a.x - b.x, a.y - b.y) || 1;
    const now = performance.now();
    if (!g.intent) {
      if (Math.abs(d - g.d0) / g.d0 > T.pinchIntentRatio) g.intent = 'pinch';
      else if (hypot(c.x - g.c0.x, c.y - g.c0.y) > T.twoFingerIntentSlopPx) g.intent = 'scroll';
      if (g.intent) g.tapOk = false;
      else if (hypot(c.x - g.c0.x, c.y - g.c0.y) > T.twoFingerTapSlopPx) g.tapOk = false;
    }
    const dx = c.x - g.lc.x, dy = c.y - g.lc.y;
    if (g.intent === 'pinch') {
      this.view.zoomAt(c.x, c.y, this.view.zoom * (d / g.ld));
      this.view.panBy(dx, dy);
    } else if (g.intent === 'scroll') {
      const nat = this.settings.get('scrollNatural') ? 1 : -1;
      const sx = -dx * T.scrollGain * nat, sy = -dy * T.scrollGain * nat;
      this.scroller.push(sx, sy);
      g.samples.push([now, sx, sy]);
      while (g.samples.length && now - g.samples[0][0] > T.momentum.sampleWindowMs * 2) g.samples.shift();
    }
    g.lc = c; g.ld = d;
  }

  _endTwo(cancel) {
    const g = this.g, T = CFG.touch;
    this.g = null;
    if (!g || cancel) return;
    const now = performance.now();
    if (g.tapOk && now - g.t0 < T.twoFingerTapMaxMs) { // two-finger tap = right click
      const pos = this._mode() === 'trackpad' ? this.cursor : this.view.toNorm(g.c0.x, g.c0.y);
      this._moveNow(pos.x, pos.y);
      this._click(1, pos.x, pos.y);
      this._haptic();
      return;
    }
    if (g.intent === 'scroll') this._startMomentum(g.samples, now);
  }

  // --- momentum scrolling after a two-finger flick ---
  _startMomentum(samples, now) {
    const M = CFG.touch.momentum;
    const recent = samples.filter((s) => now - s[0] <= M.sampleWindowMs);
    if (recent.length < 2) return;
    const dt = Math.max(1, recent[recent.length - 1][0] - recent[0][0]);
    let vx = recent.slice(1).reduce((a, s) => a + s[1], 0) / dt, vy = recent.slice(1).reduce((a, s) => a + s[2], 0) / dt;
    vx = clamp(vx, -M.maxVelocity, M.maxVelocity); vy = clamp(vy, -M.maxVelocity, M.maxVelocity);
    if (hypot(vx, vy) < M.minVelocity * 3) return;
    this.mom = { vx, vy, last: performance.now() };
    const step = () => {
      const m = this.mom; if (!m) return;
      const t = performance.now(), dtm = Math.min(50, t - m.last); m.last = t;
      this.scroller.push(m.vx * dtm, m.vy * dtm);
      const f = Math.exp(-M.decayPerMs * dtm); m.vx *= f; m.vy *= f;
      if (hypot(m.vx, m.vy) < M.minVelocity) { this.mom = null; return; }
      m.raf = requestAnimationFrame(step);
    };
    this.mom.raf = requestAnimationFrame(step);
  }
  _stopMomentum() { if (this.mom) { cancelAnimationFrame(this.mom.raf); this.mom = null; } }
}

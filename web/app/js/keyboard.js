import { CFG } from './config.js';
import { Device } from './device.js';

const MOD_CODES = new Set(['MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'CapsLock', 'Fn']);
const STICKY = { Meta: 'MetaLeft', Alt: 'AltLeft', Control: 'ControlLeft', Shift: 'ShiftLeft' };
const SENTINEL = '​';
// Padding in front of the caret so Backspace always has something to delete (Android keyboards send nothing for Backspace in an empty field).
const PAD = SENTINEL.repeat(32);

// US-layout char -> [code, needsShift]; used when a sticky modifier is armed and a char arrives from the on-screen keyboard
const CHAR_CODE = (() => {
  const m = {};
  for (const c of 'abcdefghijklmnopqrstuvwxyz') { m[c] = ['Key' + c.toUpperCase(), false]; m[c.toUpperCase()] = ['Key' + c.toUpperCase(), true]; }
  '1234567890'.split('').forEach((c) => { m[c] = ['Digit' + c, false]; });
  const shifted = { '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0' };
  for (const [s, d] of Object.entries(shifted)) m[s] = ['Digit' + d, true];
  Object.assign(m, { ' ': ['Space', false], '-': ['Minus', false], '_': ['Minus', true], '=': ['Equal', false], '+': ['Equal', true],
    '[': ['BracketLeft', false], '{': ['BracketLeft', true], ']': ['BracketRight', false], '}': ['BracketRight', true],
    '\\': ['Backslash', false], '|': ['Backslash', true], ';': ['Semicolon', false], ':': ['Semicolon', true],
    "'": ['Quote', false], '"': ['Quote', true], ',': ['Comma', false], '<': ['Comma', true], '.': ['Period', false], '>': ['Period', true],
    '/': ['Slash', false], '?': ['Slash', true], '`': ['Backquote', false], '~': ['Backquote', true] });
  return m;
})();

const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemeCount = (s) => (seg ? [...seg.segment(s)].length : [...s].length);

/** Physical keyboard events, the hidden on-screen-keyboard text field (IME-safe), sticky modifiers and one-tap combos. */
export class Keyboard extends EventTarget {
  constructor({ net, settings, ta }) {
    super();
    this.net = net; this.settings = settings; this.ta = ta;
    this.enabled = false;
    this.held = new Set();                       // codes currently down on the Mac (non-meta-combo)
    this.sticky = { Meta: 'off', Alt: 'off', Control: 'off', Shift: 'off' };
    this._stickyLast = {};
    this.switcher = false; this._switcherTimer = 0;
    this.osk = false; this.composing = false; this.prev = PAD; this._idle = 0;
    this.awaitPaste = null;
    this.onPaste = null;                         // (ClipboardEvent) => void, set by main
    this._bind();
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) this.focusTA(); else this.releaseAll();
  }

  _send(m) { if (this.enabled) this.net.send(m); }
  _kd(code, repeat) { this._send({ t: 'kd', k: code, r: !!repeat }); }
  _ku(code) { this._send({ t: 'ku', k: code }); }
  seq(ops) { this._send({ t: 'seq', ops }); }

  mapCode(code) {
    if (!this.settings.get('ctrlToCmd')) return code;
    switch (code) {
      case 'ControlLeft': return 'MetaLeft'; case 'ControlRight': return 'MetaRight';
      case 'MetaLeft': return 'ControlLeft'; case 'MetaRight': return 'ControlRight';
      default: return code;
    }
  }

  // ---------- focus / on-screen keyboard ----------
  focusTA() {
    if (!this.enabled) return;
    try { this.ta.focus({ preventScroll: true }); } catch {}
  }
  /** Show/hide the OS on-screen keyboard. The field stays focused (inputmode=none) so hardware keys and paste still work. */
  setOSK(on) {
    this.osk = on;
    this.ta.setAttribute('inputmode', on ? 'text' : 'none');
    this.ta.blur(); this._resetShadow(); this.focusTA();
    this.dispatchEvent(new CustomEvent('osk', { detail: on }));
  }
  toggleOSK() { this.setOSK(!this.osk); }

  // ---------- sticky modifiers ----------
  toggleSticky(name) {
    const now = performance.now(), s = this.sticky[name];
    const dbl = now - (this._stickyLast[name] || 0) < CFG.keyboard.stickyLockMs;
    this._stickyLast[name] = now;
    if (s === 'off') this._setSticky(name, 'once');
    else if (s === 'once' && dbl) this._setSticky(name, 'lock');
    else this._setSticky(name, 'off');
  }
  _setSticky(name, state) {
    const prev = this.sticky[name];
    this.sticky[name] = state;
    if (prev === 'off' && state !== 'off') this._kd(STICKY[name]);
    if (prev !== 'off' && state === 'off') this._ku(STICKY[name]);
    this.dispatchEvent(new Event('sticky'));
  }
  stickyActive() { return Object.values(this.sticky).some((v) => v !== 'off'); }
  /** call after a key/text/click action: releases one-shot modifiers */
  consumeSticky() {
    for (const k of Object.keys(this.sticky)) if (this.sticky[k] === 'once') this._setSticky(k, 'off');
    if (this.switcher) this._armSwitcherTimer();
  }
  releaseSticky() { for (const k of Object.keys(this.sticky)) if (this.sticky[k] !== 'off') this._setSticky(k, 'off'); this._endSwitcher(false); }

  // ---------- one-tap combos ----------
  /** combo(['MetaLeft','KeyC']) presses modifiers in order, taps last key, releases in reverse. */
  combo(codes) {
    const ops = [];
    for (const c of codes) ops.push({ k: c, d: true });
    for (const c of [...codes].reverse()) ops.push({ k: c, d: false });
    this.seq(ops);
    this.consumeSticky();
  }
  tap(code) { this.seq([{ k: code, d: true }, { k: code, d: false }]); this.consumeSticky(); }
  command(name) {
    // Sleeping the display usually locks the Mac, and a locked Mac can't be unlocked remotely.
    if (name === 'displaySleep' && !window.confirm('Sleep the display? The Mac will probably lock and you cannot unlock it from here.')) return;
    this._send({ t: 'cmd', n: name });
  }

  /** Cmd+Tab: hold Cmd, tap Tab; subsequent taps cycle; Select releases Cmd. */
  appSwitcher() {
    if (!this.switcher) {
      this.switcher = true;
      this.sticky.Meta = 'lock';
      this._kd('MetaLeft');
      this.dispatchEvent(new Event('sticky'));
    }
    this.seq([{ k: 'Tab', d: true }, { k: 'Tab', d: false }]);
    this._armSwitcherTimer();
    this.dispatchEvent(new CustomEvent('switcher', { detail: true }));
  }
  _armSwitcherTimer() { clearTimeout(this._switcherTimer); this._switcherTimer = setTimeout(() => this._endSwitcher(false), CFG.keyboard.switcherAutoReleaseMs); }
  _endSwitcher(cancel) {
    if (!this.switcher) return;
    clearTimeout(this._switcherTimer);
    this.switcher = false;
    if (cancel) this.seq([{ k: 'Escape', d: true }, { k: 'Escape', d: false }]);
    if (this.sticky.Meta !== 'off') { this.sticky.Meta = 'off'; this._ku('MetaLeft'); this.dispatchEvent(new Event('sticky')); }
    this.dispatchEvent(new CustomEvent('switcher', { detail: false }));
  }
  endSwitcher(cancel = false) { this._endSwitcher(cancel); }

  releaseAll() {
    this.held.clear();
    for (const k of Object.keys(this.sticky)) this.sticky[k] = 'off';
    this.switcher = false; clearTimeout(this._switcherTimer);
    if (this.net.open) this.net.send({ t: 'rel' });
    this.dispatchEvent(new Event('sticky'));
  }

  // ---------- physical + virtual key events ----------
  _bind() {
    window.addEventListener('keydown', (e) => this._keydown(e), true);
    window.addEventListener('keyup', (e) => this._keyup(e), true);
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
    document.addEventListener('paste', (e) => this._paste(e), true);
    const ta = this.ta;
    ta.addEventListener('compositionstart', () => { this.composing = true; });
    ta.addEventListener('compositionend', () => { this.composing = false; this._flushShadow(); });
    ta.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') { e.preventDefault(); this._enter(); }
      // Backspace with nothing left to delete fires no `input` event: forward it ourselves and refill the padding.
      if (e.inputType === 'deleteContentBackward' && !this.composing && this.enabled && this.ta.selectionStart === 0 && this.ta.selectionEnd === 0) {
        e.preventDefault(); this.tap('Backspace'); this._resetShadow();
      }
    });
    ta.addEventListener('input', () => this._flushShadow());
    ta.addEventListener('blur', () => { this._flushShadow(); });
    this._resetShadow();
  }

  _isUiInput(t) {
    if (!t || t === this.ta) return false;
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
  }

  _keydown(e) {
    if (!this.enabled || this._isUiInput(e.target)) return;
    if (e.isComposing || e.keyCode === 229) return; // IME path handles it
    const code = this.mapCode(e.code);
    const taFocused = e.target === this.ta;
    const printable = e.key.length === 1 || [...e.key].length === 1;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    const stickyOn = this.stickyActive();

    // paste: let the browser fire a paste event so we can read the local clipboard without permission prompts
    const pasteCombo = e.code === 'KeyV' && (this.settings.get('ctrlToCmd') ? e.ctrlKey : e.metaKey) && !e.shiftKey && !e.altKey;
    if (pasteCombo && taFocused) {
      this.awaitPaste = setTimeout(() => { this.awaitPaste = null; this.combo(['KeyV']); }, CFG.keyboard.pasteFallbackMs);
      return; // no preventDefault
    }
    // text typed into the hidden field: IME / layout-aware path
    if (taFocused && this.osk && plain && !stickyOn && (printable || e.key === 'Backspace')) return;
    if (this.settings.get('layoutMode') === 'text' && printable && plain && !stickyOn && e.key !== ' ') {
      e.preventDefault(); this._send({ t: 'txt', s: e.key }); return;
    }
    if (e.key === 'Enter' && taFocused && this.osk && plain) { e.preventDefault(); this._enter(); return; }

    if (!code) return;   // Android IMEs and injected events can have an empty `code`: nothing the Mac could use, let the text path handle it
    e.preventDefault(); e.stopPropagation();
    const isMod = MOD_CODES.has(code);
    if (e.repeat && !isMod) { this._kd(code, true); return; }
    if (this.held.has(code)) return;
    if (!isMod && e.metaKey && !this.settings.get('ctrlToCmd')) {
      // macOS browsers never deliver keyup for keys released while Cmd is held: send a self-contained tap
      this._kd(code); setTimeout(() => this._ku(code), 20);
    } else {
      this.held.add(code); this._kd(code);
    }
    if (!isMod) this.consumeSticky();
  }

  _keyup(e) {
    if (!this.enabled || this._isUiInput(e.target)) return;
    if (e.isComposing || e.keyCode === 229) return;
    const code = this.mapCode(e.code);
    if (this.held.has(code)) {
      this.held.delete(code);
      this._ku(code);
      e.preventDefault(); e.stopPropagation();
    }
    if (e.code === 'MetaLeft' || e.code === 'MetaRight') { // Cmd up: release anything we still think is down
      for (const c of [...this.held]) if (!MOD_CODES.has(c)) { this._ku(c); this.held.delete(c); }
    }
  }

  _paste(e) {
    if (!this.enabled || this._isUiInput(e.target)) return;
    e.preventDefault();
    clearTimeout(this.awaitPaste);
    const wasCombo = this.awaitPaste !== null; this.awaitPaste = null;
    this.onPaste?.(e, wasCombo);
  }

  // ---------- on-screen keyboard text diffing ----------
  _resetShadow() {
    this.ta.value = PAD; this.prev = PAD;
    try { this.ta.setSelectionRange(PAD.length, PAD.length); } catch {}
  }

  _enter() { this._flushShadow(); this.tap('Enter'); this._resetShadow(); }

  _flushShadow() {
    if (!this.enabled) { this._resetShadow(); return; }
    const cur = this.ta.value, prev = this.prev;
    if (cur === prev) return;
    // longest common prefix (never split a surrogate pair)
    let i = 0; const m = Math.min(prev.length, cur.length);
    while (i < m && prev.charCodeAt(i) === cur.charCodeAt(i)) i++;
    if (i > 0 && i < prev.length && (prev.charCodeAt(i - 1) & 0xfc00) === 0xd800) i--;
    const removed = prev.slice(i), added = cur.slice(i).split(SENTINEL).join('');
    const back = graphemeCount(removed);
    this.prev = cur;
    if (back) {
      const ops = []; for (let k = 0; k < back; k++) ops.push({ k: 'Backspace', d: true }, { k: 'Backspace', d: false });
      this.seq(ops);
    }
    if (added) {
      if (this.stickyActive() && [...added].length === 1 && CHAR_CODE[added]) {
        const [code, shift] = CHAR_CODE[added];
        this.combo(shift ? ['ShiftLeft', code] : [code]);
      } else { this._send({ t: 'txt', s: added }); this.consumeSticky(); }
    }
    this._scheduleShadowReset();
  }

  _scheduleShadowReset() {
    clearTimeout(this._idle);
    this._idle = setTimeout(() => { if (!this.composing && this.enabled) this._resetShadow(); }, CFG.keyboard.shadowResetIdleMs);
    if (!this.composing && this.ta.value.length > CFG.keyboard.shadowMaxChars) this._resetShadow();
  }

  // ---------- Chromium keyboard lock (fullscreen) ----------
  async lockKeys() {
    if (!Device.keyboardLock) return false;
    try { await navigator.keyboard.lock(); return true; } catch { return false; }
  }
  unlockKeys() { try { navigator.keyboard?.unlock?.(); } catch {} }
}

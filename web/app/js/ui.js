import { CFG } from './config.js';
import { Device } from './device.js';

const ICONS = {
  kbd: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  keys: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  ptr: '<path d="M5 3l14 7-6 2-2 6z"/>',
  mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v7"/>',
  zoom: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4M8 11h6"/>',
  clip: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9z"/>',
  files: '<path d="M3 6h6l2 2h10v11H3z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
  gear: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  power: '<path d="M12 3v8M6.5 6.5a8 8 0 1 0 11 0"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};
export const icon = (n) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;

export function el(tag, cls, props = {}) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') e.textContent = v; else if (k === 'html') e.innerHTML = v; else if (k.startsWith('on')) e[k] = v; else e.setAttribute(k, v);
  }
  return e;
}

/** Toolbar, key bar, panels, toasts, dialogs and connection overlays. Pure view layer; main.js wires the behaviour. */
export class UI {
  constructor(root) {
    this.root = root; this.buttons = {}; this.popover = null;
    this.toasts = el('div', 'toasts'); this.overlay = el('div', 'overlay', { hidden: '' }); this.hud = el('div', 'hud', { hidden: '' });
    this.toolbar = el('div', 'toolbar'); this.handle = el('button', 'handle', { type: 'button', 'aria-label': 'Show toolbar', html: icon('chev') });
    this.keybar = el('div', 'keybar', { hidden: '' });
    this.sheet = el('div', 'sheet', { hidden: '' });
    root.append(this.hud, this.toolbar, this.handle, this.keybar, this.sheet, this.overlay, this.toasts);
    this.handle.onclick = () => this.setToolbar(true);
    document.addEventListener('pointerdown', (e) => { if (this.popover && !this.popover.contains(e.target) && !e.target.closest('.tb')) this.closePopover(); }, true);
    this.collapsed = false;
  }

  // ---- toolbar ----
  addButton(id, ic, label, onClick, { show = true, text = '' } = {}) {
    const b = el('button', 'tb', { type: 'button', 'aria-label': label, title: label });
    b.innerHTML = icon(ic) + (text ? `<span class="tbl">${text}</span>` : '');
    b.onclick = (e) => { e.stopPropagation(); onClick(b); };
    b.hidden = !show;
    this.toolbar.append(b); this.buttons[id] = b;
    return b;
  }
  setToolbar(open) {
    this.collapsed = !open;
    this.toolbar.classList.toggle('collapsed', !open);
    this.handle.hidden = open;
    this.closePopover();
  }
  addCollapse() {
    const b = this.addButton('collapse', 'chev', 'Hide toolbar', () => this.setToolbar(false));
    b.classList.add('flip');
  }
  mark(id, on) { this.buttons[id]?.classList.toggle('on', !!on); }
  setLabel(id, text) { const b = this.buttons[id]; if (!b) return; let s = b.querySelector('.tbl'); if (!s) { s = el('span', 'tbl'); b.append(s); } s.textContent = text; }

  menu(anchor, items) {
    this.closePopover();
    const m = el('div', 'popover');
    for (const it of items) {
      if (it.sep) { m.append(el('div', 'sep')); continue; }
      const b = el('button', 'mi' + (it.on ? ' on' : ''), { type: 'button', text: it.label });
      b.onclick = () => { if (!it.keep) this.closePopover(); it.fn(); };
      m.append(b);
    }
    this.root.append(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = Math.min(window.innerHeight - 20, r.bottom + 8) + 'px';
    m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.left)) + 'px';
    this.popover = m;
  }
  closePopover() { this.popover?.remove(); this.popover = null; }

  // ---- key bar ----
  buildKeyBar(handlers) {
    const kb = this.keybar; kb.innerHTML = '';
    const row = () => { const r = el('div', 'krow'); kb.append(r); return r; };
    const chip = (r, label, fn, cls = '', key) => {
      const b = el('button', 'chip ' + cls, { type: 'button', text: label });
      // prevent the chip from stealing focus (keeps on-screen keyboard open)
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.onclick = () => { try { navigator.vibrate?.(CFG.ui.hapticMs); } catch {} fn(b); };
      if (key) this.keyChips[key] = b;
      r.append(b); return b;
    };
    this.keyChips = {};
    const r1 = row();
    chip(r1, 'Esc', () => handlers.tap('Escape'));
    chip(r1, 'Tab', () => handlers.tap('Tab'));
    chip(r1, '⌘', () => handlers.sticky('Meta'), 'mod', 'Meta');
    chip(r1, '⌥', () => handlers.sticky('Alt'), 'mod', 'Alt');
    chip(r1, '⌃', () => handlers.sticky('Control'), 'mod', 'Control');
    chip(r1, '⇧', () => handlers.sticky('Shift'), 'mod', 'Shift');
    chip(r1, '←', () => handlers.tap('ArrowLeft'));
    chip(r1, '↓', () => handlers.tap('ArrowDown'));
    chip(r1, '↑', () => handlers.tap('ArrowUp'));
    chip(r1, '→', () => handlers.tap('ArrowRight'));
    chip(r1, '⌫', () => handlers.tap('Backspace'));
    chip(r1, '⌦', () => handlers.tap('Delete'));
    chip(r1, 'Home', () => handlers.tap('Home'));
    chip(r1, 'End', () => handlers.tap('End'));
    chip(r1, 'PgUp', () => handlers.tap('PageUp'));
    chip(r1, 'PgDn', () => handlers.tap('PageDown'));
    for (let i = 1; i <= 12; i++) chip(r1, 'F' + i, () => handlers.tap('F' + i));
    const r2 = row();
    chip(r2, '⌘C', () => handlers.combo(['MetaLeft', 'KeyC']));
    chip(r2, '⌘V', () => handlers.combo(['MetaLeft', 'KeyV']));
    chip(r2, '⌘X', () => handlers.combo(['MetaLeft', 'KeyX']));
    chip(r2, '⌘Z', () => handlers.combo(['MetaLeft', 'KeyZ']));
    chip(r2, '⇧⌘Z', () => handlers.combo(['MetaLeft', 'ShiftLeft', 'KeyZ']));
    chip(r2, '⌘A', () => handlers.combo(['MetaLeft', 'KeyA']));
    chip(r2, '⌘S', () => handlers.combo(['MetaLeft', 'KeyS']));
    chip(r2, '⌘F', () => handlers.combo(['MetaLeft', 'KeyF']));
    this.switchChip = chip(r2, '⌘Tab', () => handlers.switcher(), 'wide');
    this.selectChip = chip(r2, '✓ Select', () => handlers.switcherEnd(false), 'accent', 'select'); this.selectChip.hidden = true;
    this.cancelChip = chip(r2, '✕', () => handlers.switcherEnd(true), '', 'cancel'); this.cancelChip.hidden = true;
    chip(r2, '⌘Space', () => handlers.combo(['MetaLeft', 'Space']));
    chip(r2, '⌘`', () => handlers.combo(['MetaLeft', 'Backquote']));
    chip(r2, '⌘Q', () => handlers.combo(['MetaLeft', 'KeyQ']));
    chip(r2, '⌘W', () => handlers.combo(['MetaLeft', 'KeyW']));
    chip(r2, '⌘T', () => handlers.combo(['MetaLeft', 'KeyT']));
    chip(r2, '⌘H', () => handlers.combo(['MetaLeft', 'KeyH']));
    chip(r2, '⌃←', () => handlers.combo(['ControlLeft', 'ArrowLeft']));
    chip(r2, '⌃→', () => handlers.combo(['ControlLeft', 'ArrowRight']));
    chip(r2, 'Mission Ctrl', () => handlers.command('missionControl'), 'wide');
    chip(r2, 'Launchpad', () => handlers.command('launchpad'), 'wide');
    chip(r2, 'Desktop', () => handlers.tap('F11'), 'wide');
    chip(r2, 'Shot', () => handlers.combo(['MetaLeft', 'ShiftLeft', 'Digit3']), 'wide');
    chip(r2, 'Shot ▭', () => handlers.combo(['MetaLeft', 'ShiftLeft', 'Digit4']), 'wide');
    chip(r2, 'Shot ⚙', () => handlers.combo(['MetaLeft', 'ShiftLeft', 'Digit5']), 'wide');
    chip(r2, 'Lock', () => handlers.combo(['ControlLeft', 'MetaLeft', 'KeyQ']));
    chip(r2, 'Sleep display', () => handlers.command('displaySleep'), 'wide');
  }
  setSticky(state) {
    for (const k of ['Meta', 'Alt', 'Control', 'Shift']) {
      const c = this.keyChips?.[k]; if (!c) continue;
      c.classList.toggle('on', state[k] === 'once'); c.classList.toggle('lock', state[k] === 'lock');
    }
  }
  setSwitcher(on) {
    this.selectChip.hidden = !on; this.cancelChip.hidden = !on;
    this.switchChip.textContent = on ? 'Next ⇥' : '⌘Tab';
  }
  showKeyBar(on) { this.keybar.hidden = !on; this.mark('keys', on); document.documentElement.classList.toggle('keybar-open', on); }

  // ---- sheet (files / settings) ----
  openSheet(title, content, onClose) {
    this.sheet.innerHTML = '';
    const head = el('div', 'shead');
    head.append(el('strong', '', { text: title }));
    const x = el('button', 'tb', { type: 'button', 'aria-label': 'Close', html: icon('close') });
    x.onclick = () => this.closeSheet();
    head.append(x);
    const body = el('div', 'sbody'); body.append(content);
    this.sheet.append(head, body);
    this.sheet.hidden = false; this._sheetClose = onClose;
    document.documentElement.classList.add('sheet-open');
  }
  closeSheet() { if (this.sheet.hidden) return; this.sheet.hidden = true; document.documentElement.classList.remove('sheet-open'); this._sheetClose?.(); this._sheetClose = null; }

  // ---- toasts ----
  toast(text, action) {
    const t = el('div', 'toast');
    t.append(el('span', '', { text }));
    if (action) { const b = el('button', 'toastbtn', { type: 'button', text: action.label || action.action }); b.onclick = () => { action.fn(); t.remove(); }; t.append(b); }
    this.toasts.append(t);
    setTimeout(() => t.remove(), CFG.ui.toastMs + (action ? 3000 : 0));
    while (this.toasts.children.length > 4) this.toasts.firstChild.remove();
  }

  // ---- overlay / dialogs ----
  showOverlay({ title, body, actions = [], spinner = false, tone = '' }) {
    const o = this.overlay; o.innerHTML = ''; o.hidden = false; o.className = 'overlay ' + tone;
    const card = el('div', 'card');
    if (spinner) card.append(el('div', 'spin'));
    if (title) card.append(el('h2', '', { text: title }));
    if (body) { const p = el('p'); if (typeof body === 'string') p.textContent = body; else p.append(body); card.append(p); }
    if (actions.length) {
      const row = el('div', 'actions');
      for (const a of actions) { const b = el('button', 'btn' + (a.primary ? ' primary' : ''), { type: 'button', text: a.label }); b.onclick = a.fn; row.append(b); }
      card.append(row);
    }
    o.append(card);
  }
  hideOverlay() { this.overlay.hidden = true; this.overlay.innerHTML = ''; }
  setHud(text) { this.hud.textContent = text; this.hud.hidden = !text; }
}

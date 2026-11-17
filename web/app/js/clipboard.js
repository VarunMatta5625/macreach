import { Device } from './device.js';

const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function toPng(blob) {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  return new Promise((r) => c.toBlob(r, 'image/png'));
}

/** Two-way clipboard sync between the Mac and this device.
 *  iOS/Safari only allow clipboard writes inside a user gesture, so Mac->device changes are applied on the next tap. */
export class ClipSync {
  constructor({ net, settings, ui, uploader }) {
    this.net = net; this.settings = settings; this.ui = ui; this.uploader = uploader;
    this.pending = null; this.lastFromMac = ''; this.lastToMac = '';
    for (const ev of ['pointerup', 'keydown', 'touchend']) window.addEventListener(ev, () => this.flushPending(), { capture: true, passive: true });
    window.addEventListener('focus', () => this._autoPush());
  }
  get on() { return this.settings.get('clipSync'); }

  onMessage(m) {
    if (!this.on) return;
    if (m.files?.length) this.ui.toast(`Mac copied ${m.files.length} file${m.files.length > 1 ? 's' : ''}`, { action: 'Download', fn: () => this.ui.openFiles(m.files) });
    if (typeof m.text === 'string') {
      if (m.text === this.lastToMac) return;       // our own echo
      this.lastFromMac = m.text; this.pending = { text: m.text };
    } else if (m.png) { this.pending = { png: m.png }; }
    else return;
    this.flushPending(true);
  }

  async flushPending(announce = false) {
    const p = this.pending; if (!p) return;
    try {
      if (p.text !== undefined) await navigator.clipboard.writeText(p.text);
      else if (p.png) await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([unb64(p.png)], { type: 'image/png' }) })]);
      this.pending = null;
      if (announce) this.ui.toast(p.png ? 'Image copied from Mac' : 'Copied from Mac');
    } catch {
      if (announce) this.ui.toast('Mac clipboard ready — tap anywhere to copy it here');
    }
  }

  sendText(text) {
    if (typeof text !== 'string' || !text) return false;
    this.lastToMac = text;
    return this.net.send({ t: 'clip', text });
  }
  async sendBlob(blob) {
    const png = await toPng(blob);
    return this.net.send({ t: 'clip', png: b64(await png.arrayBuffer()) });
  }

  /** From a paste event (Cmd/Ctrl+V on a hardware keyboard, or the OS paste action). Returns true if something was sent. */
  async fromPasteEvent(e) {
    const dt = e.clipboardData; if (!dt) return false;
    const files = [...(dt.files || [])];
    if (files.length) {
      const img = files.find((f) => f.type.startsWith('image/'));
      if (img && files.length === 1) { await this.sendBlob(img); return true; }
      this.uploader?.(files); return false;
    }
    const text = dt.getData('text/plain');
    return this.sendText(text);
  }

  /** Toolbar "Paste to Mac": reads this device's clipboard (needs a user gesture) and pastes on the Mac. */
  async pasteToMac(keys) {
    try {
      if (navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          if (it.types.includes('text/plain')) { this.sendText(await (await it.getType('text/plain')).text()); keys(); return; }
          const imgT = it.types.find((t) => t.startsWith('image/'));
          if (imgT) { await this.sendBlob(await it.getType(imgT)); keys(); return; }
        }
      }
      const t = await navigator.clipboard.readText();
      if (t) { this.sendText(t); keys(); } else this.ui.toast('Clipboard is empty');
    } catch {
      try { const t = await navigator.clipboard.readText(); if (t) { this.sendText(t); keys(); return; } } catch {}
      this.ui.toast(Device.isSafari || Device.isIPadOS || Device.isIPhone ? 'Allow “Paste” when asked, or long-press the keyboard field' : 'Clipboard access was blocked');
    }
  }

  /** Ask the Mac for its current clipboard (explicit pull). */
  pull() { this.net.send({ t: 'clipPull' }); }

  async _autoPush() {
    if (!this.on || !document.hasFocus() || !navigator.clipboard?.readText) return;
    try {
      const st = await navigator.permissions?.query({ name: 'clipboard-read' });
      if (st && st.state !== 'granted') return;
      const t = await navigator.clipboard.readText();
      if (t && t !== this.lastToMac && t !== this.lastFromMac) this.sendText(t);
    } catch {}
  }
}

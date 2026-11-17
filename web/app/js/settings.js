import { Device } from './device.js';

const KEY = 'mr.settings.v1';
const BASE = {
  ctrlToCmd: null, touchMode: null, layoutMode: null,
  scrollNatural: true, scrollInvertMac: false,
  qualityAuto: true, qualityLevel: 3, maxLevel: 5,
  displayId: null, showStats: false, keyBar: false, clipSync: true, toolbarOpen: true,
};

function read() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } }

/** Per-device settings. Only values the user explicitly changed are persisted, so device-derived defaults
 *  (iPad = direct touch, phone = trackpad, Windows = Ctrl->Cmd) keep adapting until the user chooses. */
export class Settings extends EventTarget {
  constructor() {
    super();
    this.explicit = read();
    this.derived = Device.defaults();
    this.v = { ...BASE, ...this.derived, ...this.explicit };
  }
  get(k) { return this.v[k]; }
  has(k) { return k in this.explicit; }
  set(k, val) {
    if (this.v[k] === val && this.has(k)) return;
    this.v[k] = val; this.explicit[k] = val;
    try { localStorage.setItem(KEY, JSON.stringify(this.explicit)); } catch {}
    this.dispatchEvent(new CustomEvent('change', { detail: { key: k, value: val } }));
  }
}

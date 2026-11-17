// Client capability + form-factor detection.
const ua = navigator.userAgent || '';
const plat = navigator.userAgentData?.platform || navigator.platform || '';
const touchPoints = navigator.maxTouchPoints || 0;
const mm = (q) => { try { return matchMedia(q).matches; } catch { return false; } };

const isIPadOS = /iPad/.test(ua) || (plat === 'MacIntel' && touchPoints > 1);
const isIPhone = /iPhone|iPod/.test(ua);
const isAndroid = /Android/i.test(ua);
const isMac = !isIPadOS && /Mac/i.test(plat);
const isWindows = /Win/i.test(plat);
const isLinux = !isAndroid && /Linux|X11|CrOS/i.test(plat + ua) && !isMac && !isWindows;
const isFirefox = /Firefox\//.test(ua);
const isSafari = /Safari\//.test(ua) && !/Chrome|Chromium|Edg|CriOS|FxiOS/.test(ua);
const isChromium = !!navigator.userAgentData?.brands?.some((b) => /Chromium|Chrome/.test(b.brand)) || /Chrome\//.test(ua);
const coarse = mm('(pointer: coarse)');
const finePrimary = mm('(any-pointer: fine)') && mm('(hover: hover)') && !isIPhone && !isAndroid;
const hasTouch = touchPoints > 0 || 'ontouchstart' in window;
const isTouchPrimary = (isIPadOS || isIPhone || isAndroid) || (coarse && !finePrimary);

export const Device = {
  isIPadOS, isIPhone, isAndroid, isMac, isWindows, isLinux, isFirefox, isSafari, isChromium,
  hasTouch, isTouchPrimary,
  isPhone: isIPhone || (isAndroid && Math.min(screen.width, screen.height) < 600),
  isTablet: isIPadOS || (isAndroid && Math.min(screen.width, screen.height) >= 600),
  isDesktop: !isTouchPrimary,
  os: isIPadOS ? 'ipados' : isIPhone ? 'ios' : isAndroid ? 'android' : isMac ? 'macos' : isWindows ? 'windows' : isLinux ? 'linux' : 'other',
  standalone: !!navigator.standalone || mm('(display-mode: standalone)'),
  fullscreenApi: !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen) && !isIPhone,
  keyboardLock: !!navigator.keyboard?.lock,
  /** Defaults chosen per device; user choices are persisted separately. */
  defaults() {
    return {
      touchMode: isIPadOS ? 'direct' : 'trackpad',
      ctrlToCmd: isWindows || isLinux,
      layoutMode: 'code',
    };
  },
  describe() { return `${this.os}${this.isPhone ? ' phone' : this.isTablet ? ' tablet' : ''}${isTouchPrimary ? ' touch' : ''}`; },
};

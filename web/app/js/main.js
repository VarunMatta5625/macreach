import { CFG } from './config.js';
import { Device } from './device.js';
import { Settings } from './settings.js';
import { Net } from './net.js';
import { Video } from './video.js';
import { View } from './view.js';
import { InputController } from './input.js';
import { Keyboard } from './keyboard.js';
import { ClipSync } from './clipboard.js';
import { Files } from './files.js';
import { UI, el } from './ui.js';
import { api, apiJSON, setCsrf } from './api.js';

const $ = (id) => document.getElementById(id);
const settings = new Settings();
const net = new Net();
const ui = new UI($('ui'));
const canvas = $('screen'), stage = $('stage');
const view = new View(stage, canvas);
const video = new Video(canvas, net);
const kb = new Keyboard({ net, settings, ta: $('kb') });
const input = new InputController({ stage, view, net, settings, ui, marker: $('marker'), ring: $('ring') });
const filesPanel = el('div', 'files');
const files = new Files({ ui, root: filesPanel });
const clip = new ClipSync({ net, settings, ui, uploader: (f) => files.upload(f) });

const S = { status: null, displays: [], display: null, params: null, ladder: [], qstats: null, ready: false, helperDown: false, probe: { h264: false } };

ui.openFiles = (paths) => {
  ui.openSheet('Files', filesPanel);
  if (paths?.length) files.showPaths(paths); else files.open();
};
input.ui = Object.assign(input.ui || {}, {
  afterClick: () => kb.consumeSticky(),
  oneShotChanged: (v) => { ui.mark('click', !!v || input.dragLock); },
});

// ---------------------------------------------------------------- viewport (mobile keyboards, safe areas)
function fitViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight, top = vv ? vv.offsetTop : 0;
  document.documentElement.style.setProperty('--vvh', h + 'px');
  document.documentElement.style.setProperty('--vvt', top + 'px');
  view.layout();
}
window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', fitViewport);
window.addEventListener('resize', fitViewport);
window.addEventListener('orientationchange', () => setTimeout(fitViewport, 200));
fitViewport();

// ---------------------------------------------------------------- toolbar
function buildToolbar() {
  const touch = Device.isTouchPrimary || Device.hasTouch;
  ui.addButton('kbd', 'kbd', 'On-screen keyboard (use your keyboard, dictation or emoji)', () => { kb.toggleOSK(); }, { show: touch });
  ui.addButton('keys', 'keys', 'Shortcut keys', () => { settings.set('keyBar', !settings.get('keyBar')); });
  ui.addButton('mission', 'mission', 'Mission Control (see all windows)', () => kb.command('missionControl'));
  ui.addButton('mode', 'ptr', 'Touch mode', (b) => ui.menu(b, [
    { label: (settings.get('touchMode') === 'direct' ? '● ' : '○ ') + 'Direct (touchscreen)', fn: () => settings.set('touchMode', 'direct') },
    { label: (settings.get('touchMode') === 'trackpad' ? '● ' : '○ ') + 'Trackpad (relative cursor)', fn: () => settings.set('touchMode', 'trackpad') },
  ]), { show: touch, text: settings.get('touchMode') === 'direct' ? 'Direct' : 'Pad' });
  ui.addButton('click', 'mouse', 'Click options', (b) => ui.menu(b, [
    { label: 'Right-click next tap', on: input.oneShot === 'right', fn: () => { input.oneShot = input.oneShot === 'right' ? null : 'right'; ui.mark('click', !!input.oneShot || input.dragLock); } },
    { label: 'Middle-click next tap', on: input.oneShot === 'middle', fn: () => { input.oneShot = input.oneShot === 'middle' ? null : 'middle'; ui.mark('click', !!input.oneShot || input.dragLock); } },
    { label: input.dragLock ? 'Release drag lock' : 'Drag lock (hold button)', on: input.dragLock, fn: toggleDragLock },
    { sep: true },
    { label: 'Double-click here', fn: () => { input._click(0, input.cursor.x, input.cursor.y, 1); input._click(0, input.cursor.x, input.cursor.y, 2); } },
  ]));
  ui.addButton('zoom', 'zoom', 'Zoom', (b) => ui.menu(b, [
    { label: 'Fit to screen', fn: () => view.reset() },
    { label: 'Zoom in', keep: true, fn: () => view.zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, view.zoom * 1.4) },
    { label: 'Zoom out', keep: true, fn: () => view.zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, view.zoom / 1.4) },
    { label: '100% (1 Mac pixel = 1 px)', fn: () => { const dpr = window.devicePixelRatio || 1; view.zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, Math.max(1, (video.w / dpr) / view.bw)); } },
  ]));
  ui.addButton('clip', 'clip', 'Clipboard', (b) => ui.menu(b, [
    { label: 'Paste this device’s clipboard to Mac', fn: () => clip.pasteToMac(() => kb.combo(['MetaLeft', 'KeyV'])) },
    { label: 'Get Mac’s clipboard here', fn: () => { clip.pull(); ui.toast('Requested Mac clipboard'); } },
    { label: settings.get('clipSync') ? '✓ Auto-sync on' : 'Auto-sync off', fn: () => settings.set('clipSync', !settings.get('clipSync')) },
  ]));
  ui.addButton('display', 'monitor', 'Choose which Mac display to control', (b) => ui.menu(b,
    S.displays.map((d) => ({ label: (S.display?.id === d.id ? '● ' : '○ ') + displayLabel(d), fn: () => chooseDisplay(d.id) }))), { show: false });
  ui.addButton('files', 'files', 'Files', () => ui.openFiles());
  ui.addButton('full', 'full', 'Full screen', toggleFullscreen, { show: Device.fullscreenApi });
  ui.addButton('stats', 'stats', 'Connection stats', () => settings.set('showStats', !settings.get('showStats')));
  ui.addButton('settings', 'gear', 'Settings', () => openSettings());
  ui.addButton('quit', 'power', 'Disconnect', () => { net.close(); ui.showOverlay({ title: 'Disconnected', body: 'Remote control ended.', actions: [{ label: 'Reconnect', primary: true, fn: () => location.reload() }, { label: 'Sign out', fn: signOut }] }); });
  ui.addCollapse();
}

function toggleDragLock() {
  input.dragLock = !input.dragLock;
  input._btn(0, input.dragLock, input.cursor.x, input.cursor.y, 1);
  ui.mark('click', !!input.oneShot || input.dragLock);
  ui.toast(input.dragLock ? 'Drag lock on — move, then tap Click ▸ Release' : 'Drag lock off');
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); kb.unlockKeys(); }
    else { await (document.documentElement.requestFullscreen?.() ?? document.documentElement.webkitRequestFullscreen()); if (await kb.lockKeys()) ui.toast('Keyboard captured — ⌘W, ⌘T and ⌘Tab now go to the Mac'); }
  } catch {}
}
document.addEventListener('fullscreenchange', () => { ui.mark('full', !!document.fullscreenElement); if (!document.fullscreenElement) kb.unlockKeys(); setTimeout(fitViewport, 100); });

async function signOut() {
  try { await api('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); } catch {}
  location.replace('/');
}

// ---------------------------------------------------------------- displays
const displayLabel = (d) => d.label || d.name || `Display ${d.id}`;
function chooseDisplay(id) {
  settings.set('displayId', id);   // remembered, so the next connection opens the same display
  net.send({ t: 'display', id });
}
function refreshDisplayUI() {
  const multi = S.displays.length > 1;
  if (ui.buttons.display) ui.buttons.display.hidden = !multi;
  if (multi && S.display) { const i = S.displays.findIndex((d) => d.id === S.display.id); ui.setLabel('display', S.display.builtin ? 'Mac' : String(i < 0 ? '?' : i)); }
}

// ---------------------------------------------------------------- settings sheet
function openSettings() {
  const root = el('div', 'settings');
  const sec = (t) => root.append(el('h3', '', { text: t }));
  const row = (label, ctl, hint) => { const r = el('div', 'srow'); const l = el('label', '', { text: label }); r.append(l, ctl); root.append(r); if (hint) root.append(el('p', 'hint', { text: hint })); return r; };
  const select = (opts, cur, fn) => { const s = el('select'); for (const [v, t] of opts) { const o = el('option', '', { value: v, text: t }); if (String(v) === String(cur)) o.selected = true; s.append(o); } s.onchange = () => fn(s.value); return s; };
  const toggle = (cur, fn) => { const c = el('input', '', { type: 'checkbox' }); c.checked = !!cur; c.onchange = () => fn(c.checked); return c; };

  sec('Input');
  row('Touch mode', select([['direct', 'Direct (touchscreen)'], ['trackpad', 'Trackpad (relative)']], settings.get('touchMode'), (v) => settings.set('touchMode', v)),
    Device.isIPadOS ? 'iPad: Direct by default. Pencil is always a precise pointer.' : Device.isPhone ? 'Phones default to Trackpad mode.' : '');
  row('Natural touch scrolling', toggle(settings.get('scrollNatural'), (v) => settings.set('scrollNatural', v)), 'Drag two fingers up to move content up.');
  row('Invert scroll on the Mac', toggle(settings.get('scrollInvertMac'), (v) => settings.set('scrollInvertMac', v)), 'Flip this if scrolling goes the wrong way.');
  sec('Keyboard');
  row('Ctrl → Cmd', toggle(settings.get('ctrlToCmd'), (v) => settings.set('ctrlToCmd', v)),
    Device.isWindows || Device.isLinux ? 'Suggested on Windows/Linux: Ctrl+C becomes ⌘C (and Ctrl/Win are swapped).' : 'For Windows/Linux keyboards.');
  row('Typing', select([['code', 'Physical keys (best for shortcuts/games)'], ['text', 'Characters (best for non-US layouts)']], settings.get('layoutMode'), (v) => settings.set('layoutMode', v)),
    'Characters mode sends what you type, so AZERTY/QWERTZ/etc. produce the right letters on the Mac.');
  sec('Video');
  row('Quality', select([['auto', 'Automatic (adapts to your connection)'], ['fixed', 'Fixed']], settings.get('qualityAuto') ? 'auto' : 'fixed', (v) => { settings.set('qualityAuto', v === 'auto'); sendQuality(); }));
  const ladder = S.ladder.length ? S.ladder : ['saver', 'low', 'medium', '1080p', '1080p60', 'native'].map((name) => ({ name }));
  row(settings.get('qualityAuto') ? 'Highest level' : 'Level', select(ladder.map((l, i) => [i, l.name]), settings.get('qualityAuto') ? settings.get('maxLevel') : settings.get('qualityLevel'), (v) => {
    if (settings.get('qualityAuto')) settings.set('maxLevel', +v); else settings.set('qualityLevel', +v); sendQuality();
  }), 'saver = mobile data · 1080p/1080p60 = full HD · native = Mac’s full resolution');
  if (S.displays.length > 1) row('Display', select(S.displays.map((d) => [d.id, displayLabel(d)]), S.display?.id, (v) => chooseDisplay(+v)));
  row('Show stats', toggle(settings.get('showStats'), (v) => settings.set('showStats', v)));
  sec('Clipboard');
  row('Sync clipboard', toggle(settings.get('clipSync'), (v) => { settings.set('clipSync', v); net.send({ t: 'clipSync', on: v }); }));
  sec('Mac');
  const acts = el('div', 'srow wrap');
  for (const [t, fn] of [['Lock screen', () => kb.combo(['ControlLeft', 'MetaLeft', 'KeyQ'])], ['Sleep display', () => kb.command('displaySleep')], ['Request keyframe', () => net.send({ t: 'keyframe' })]]) {
    const b = el('button', 'btn', { type: 'button', text: t }); b.onclick = fn; acts.append(b);
  }
  root.append(acts);
  sec('Account');
  const out = el('button', 'btn', { type: 'button', text: 'Sign out' }); out.onclick = signOut; root.append(out);
  root.append(el('p', 'hint', { text: `Detected: ${Device.describe()}` }));
  ui.openSheet('Settings', root);
}

function sendQuality() {
  const auto = settings.get('qualityAuto');
  net.send({ t: 'quality', auto, maxLevel: settings.get('maxLevel'), level: auto ? undefined : settings.get('qualityLevel') });
}

// ---------------------------------------------------------------- key bar
ui.buildKeyBar({
  tap: (c) => kb.tap(c),
  combo: (c) => kb.combo(c),
  sticky: (n) => kb.toggleSticky(n),
  command: (n) => kb.command(n),
  switcher: () => kb.appSwitcher(),
  switcherEnd: (cancel) => kb.endSwitcher(cancel),
});
kb.addEventListener('sticky', () => ui.setSticky(kb.sticky));
kb.addEventListener('switcher', (e) => ui.setSwitcher(e.detail));
kb.addEventListener('osk', (e) => { ui.mark('kbd', e.detail); document.documentElement.classList.toggle('osk-open', e.detail); setTimeout(fitViewport, 300); });
kb.onPaste = async (e, wasCombo) => {
  const sent = await clip.fromPasteEvent(e);
  if (sent && wasCombo) kb.combo(['KeyV']);   // Cmd (or mapped Ctrl) is still held on the Mac
  else if (wasCombo) kb.combo(['KeyV']);
};

// ---------------------------------------------------------------- settings reactions
settings.addEventListener('change', (e) => {
  const { key } = e.detail;
  if (key === 'keyBar') { ui.showKeyBar(settings.get('keyBar')); setTimeout(fitViewport, 50); }
  if (key === 'showStats') renderHud();
  if (key === 'touchMode') { ui.setLabel('mode', settings.get('touchMode') === 'direct' ? 'Direct' : 'Pad'); input._placeMarker(); input.cancelAll?.(); }
  if (key === 'scrollInvertMac') net.send({ t: 'scrollInvert', on: settings.get('scrollInvertMac') });
  if (key === 'clipSync') net.send({ t: 'clipSync', on: settings.get('clipSync') });
});

// On a slow path (Funnel, mobile data) the Mac's cursor in the video trails the pointer by a full round trip, which feels broken.
// Show the device's own pointer then. Hysteresis keeps it from flickering around the threshold.
setInterval(() => {
  const r = net.rttAvg;
  if (!r) return;
  if (r > 120) stage.classList.add('lag'); else if (r < 70) stage.classList.remove('lag');
}, 1000);

function renderHud() {
  if (!settings.get('showStats')) { ui.setHud(''); return; }
  const q = S.qstats, p = S.params;
  const mbps = (video.stats.bps / 1e6).toFixed(1);
  ui.setHud(`${q?.name || '-'} ${p ? (p.maxW || 'native') + (p.maxW ? '×' + p.maxH : '') + '@' + p.fps : ''} · ${video.w}×${video.h} · ${mbps} Mbps · ${video.stats.fps} fps · RTT ${Math.round(net.rtt)} ms · dec ${video.stats.decodeMs.toFixed(1)} ms${video.kind ? ' · ' + video.kind : ''}${video.stats.dropped ? ' · drop ' + video.stats.dropped : ''}`);
}
video.addEventListener('stats', renderHud);

// ---------------------------------------------------------------- video events
video.addEventListener('resize', (e) => view.setVideoSize(e.detail.w, e.detail.h));
video.addEventListener('first', () => { ui.hideOverlay(); refreshStateOverlay(); });
video.addEventListener('fatal', () => net.send({ t: 'attach', codecs: ['jpeg'], mode: 'auto' })); // decoder refused: fall back
net.onVideo = (buf) => video.onFrame(buf);

// ---------------------------------------------------------------- connection state
function setLive(on) { input.setEnabled(on); kb.setEnabled(on); }

function refreshStateOverlay() {
  if (!S.ready) return;
  const st = S.status;
  if (S.helperDown) return ui.showOverlay({ title: 'Mac agent not running', body: 'The MacReach helper on your Mac is not responding. It restarts automatically; if this persists, run “macreach doctor” on the Mac.', spinner: true });
  if (st && st.screen === false) return ui.showOverlay({ title: 'Screen Recording permission needed', body: 'On the Mac: System Settings → Privacy & Security → Screen & System Audio Recording → enable MacReach. Streaming starts automatically once granted.', spinner: true, tone: 'warn' });
  if (st && st.accessibility === false) ui.toast('Mac: Accessibility permission missing — input is disabled until MacReach is enabled in Privacy & Security → Accessibility');
  if (st?.locked) return ui.showOverlay({ title: 'Mac is locked', body: 'The Mac is at the lock screen. Remote control cannot unlock it; unlock it locally.', tone: 'warn' });
  if (!video.firstPainted) return ui.showOverlay({ title: 'Starting stream…', spinner: true });
  ui.hideOverlay();
}

net.addEventListener('open', () => { ui.showOverlay({ title: 'Connecting…', spinner: true }); });
net.addEventListener('close', (e) => {
  S.ready = false; setLive(false); video.reset();
  const { code, final } = e.detail;
  if (final) return; // dialog already shown by message handler
  ui.showOverlay({ title: 'Reconnecting…', body: 'Connection lost. Retrying automatically.', spinner: true });
  void code;
});

net.addEventListener('msg', (ev) => {
  const m = ev.detail;
  switch (m.t) {
    case 'busy':
      ui.showOverlay({
        title: 'Mac is in use', body: `Another device (${shortUA(m.other?.ua)}${m.other?.ip ? ', ' + m.other.ip : ''}) is controlling this Mac. Take over control? It will be disconnected.`,
        actions: m.allowTakeover ? [{ label: 'Take over', primary: true, fn: () => { ui.showOverlay({ title: 'Taking over…', spinner: true }); net.send({ t: 'takeover' }); } }, { label: 'Cancel', fn: () => { net.close(); ui.showOverlay({ title: 'Not connected', actions: [{ label: 'Try again', primary: true, fn: () => location.reload() }] }); } }]
          : [{ label: 'Try again', fn: () => location.reload() }],
      });
      break;
    case 'ready':
      S.ready = true; S.status = m.status; S.helperDown = !m.helperUp; S.ladder = [];
      if (m.status?.displays) { S.displays = m.status.displays; S.display = m.status.display || S.display; refreshDisplayUI(); }
      if (m.clipboard === false) settings.set('clipSync', false);
      net.send({ t: 'scrollInvert', on: settings.get('scrollInvertMac') });
      net.send({ t: 'attach', codecs: S.probe.h264 ? ['h264', 'jpeg'] : ['jpeg'], mode: settings.get('qualityAuto') ? 'auto' : 'fixed', level: settings.get('qualityAuto') ? undefined : settings.get('qualityLevel'), maxLevel: settings.get('maxLevel'), clipSync: settings.get('clipSync'), display: Number.isInteger(settings.get('displayId')) ? settings.get('displayId') : undefined });
      setLive(true);
      S.selfView = !!m.selfView;
      if (S.selfView) ui.toast('You are viewing this Mac from itself, so mouse and keyboard are off here (they would fight your real mouse). Open this from another device to control it.', { label: 'Turn input on anyway', fn: () => { net.send({ t: 'selfInput', on: true }); ui.toast('Input on. Expect the cursor to fight you.'); } });
      refreshStateOverlay();
      if (!video.firstPainted) ui.showOverlay({ title: 'Starting stream…', spinner: true });
      break;
    case 'attached': S.params = m.params; S.ladder = m.ladder || []; break;
    case 'videoConfig': video.configure(m); break;
    case 'status': S.status = m; S.displays = m.displays || S.displays; S.display = m.display || S.display; S.helperDown = false; refreshDisplayUI(); refreshStateOverlay(); break;
    case 'display': {
      const prev = S.display;
      S.display = m.display; S.displays = m.displays || S.displays; view.reset(); refreshDisplayUI();
      const want = settings.get('displayId');
      if (prev && prev.id !== m.display.id) ui.toast(Number.isInteger(want) && want !== m.display.id ? `Display unavailable, showing ${displayLabel(m.display)}` : `Showing ${displayLabel(m.display)}`);
      break;
    }
    case 'streamError': if (m.error === 'screen-recording-permission-missing') { S.status = { ...(S.status || {}), screen: false }; refreshStateOverlay(); } break;
    case 'helperDown': S.helperDown = true; refreshStateOverlay(); break;
    case 'qstats': S.qstats = m; S.params = m.params || S.params; break;
    case 'clip': clip.onMessage(m); break;
    case 'taken': endedDialog('Control was taken over', `Another device (${shortUA(m.by?.ua)}) took control of this Mac.`); break;
    case 'replaced': endedDialog('Opened elsewhere', 'This session was opened in another tab or window.'); break;
    case 'expired': location.replace('/'); break;
    case 'ended': endedDialog('Session ended', m.reason === 'logout' ? 'You signed out.' : 'Remote control was ended.'); break;
  }
});

function endedDialog(title, body) {
  S.ready = false; setLive(false); video.reset();
  ui.showOverlay({ title, body, actions: [{ label: 'Reconnect', primary: true, fn: () => location.reload() }, { label: 'Sign out', fn: signOut }] });
}

function shortUA(ua = '') {
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  const o = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${o ? ' on ' + o : ''}`;
}

// ---------------------------------------------------------------- boot
(async function boot() {
  const r = await fetch('/api/session', { credentials: 'same-origin' });
  if (r.status === 401) { location.replace('/'); return; }
  const sess = await r.json();
  setCsrf(sess.csrf);
  S.probe = await Video.probe();
  buildToolbar();
  ui.showKeyBar(settings.get('keyBar'));
  ui.setToolbar(settings.get('toolbarOpen'));
  // non-US keyboard layouts: suggest "characters" typing unless the user chose already
  try {
    const map = await navigator.keyboard?.getLayoutMap?.();
    if (map && !settings.has('layoutMode') && !(map.get('KeyQ') === 'q' && map.get('KeyW') === 'w' && map.get('KeyY') === 'y' && map.get('KeyA') === 'a')) settings.v.layoutMode = 'text';
  } catch {}
  if (!settings.has('ctrlToCmd') && settings.get('ctrlToCmd')) ui.toast('Windows/Linux keyboard detected: Ctrl works as ⌘ (change in Settings)');
  net.connect();
  window.__mr = { net, video, view, input, kb, settings, S, clip, files }; // debugging / tests
})().catch((e) => { console.error(e); ui.showOverlay({ title: 'Could not start', body: String(e.message || e), actions: [{ label: 'Retry', primary: true, fn: () => location.reload() }] }); });

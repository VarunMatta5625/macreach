import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Hub } from '../src/hub.js';
import { deviceName } from '../src/util.js';

function fakeHub(config = {}) {
  const helper = Object.assign(new EventEmitter(), { sent: [], up: true, send(m) { this.sent.push(m); } });
  const hub = new Hub({ config: { paused: false, ...config }, helper, sessions: {} });
  clearInterval(hub.timer);
  return { hub, helper };
}

test('pushSession reports idle, then the active controller, and resends when the helper reconnects', () => {
  const { hub, helper } = fakeHub();
  hub.pushSession();
  assert.deepEqual(helper.sent.at(-1), { c: 'session', active: false, device: '', ip: '', since: 0, selfView: false, paused: false });
  hub.active = { ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36', ip: '100.1.2.3', since: 1234, selfView: false, attached: false };
  helper.emit('up');   // KeepAlive restarted the helper: it must learn about the live session
  const m = helper.sent.at(-1);
  assert.equal(m.active, true); assert.equal(m.device, 'Android Chrome'); assert.equal(m.ip, '100.1.2.3'); assert.equal(m.since, 1234);
});

test('pushSession carries the paused flag', () => {
  const { hub, helper } = fakeHub({ paused: true });
  hub.pushSession();
  assert.equal(helper.sent.at(-1).paused, true);
});

test('deviceName', () => {
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605.1'), 'iPhone Safari');
  assert.equal(deviceName('Mozilla/5.0 (Macintosh) Chrome/120 Safari/537'), 'Mac Chrome');
  assert.equal(deviceName(''), 'Device browser');
});

test('liveness: a client that is slow to answer a ping (Funnel RTT + queued video) is not dropped; a silent one is', () => {
  const { hub } = fakeHub();
  hub.sessions = { map: new Map([['h', {}]]), expired: () => false };
  const calls = { terminate: 0, ping: 0 };
  const ws = { lastSeen: Date.now() - 10_000, terminate: () => calls.terminate++, ping: () => calls.ping++, close() {} };
  hub.active = { ws, session: { idHash: 'h' }, ip: '1.2.3.4', ua: '', attached: false };
  hub._tick();
  assert.equal(calls.terminate, 0, '10 s of silence must not terminate');
  assert.equal(calls.ping, 1);
  ws.lastSeen = Date.now() - 30_000;
  hub._tick();
  assert.equal(calls.terminate, 1, '30 s of silence terminates');
});

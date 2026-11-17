import test from 'node:test';
import assert from 'node:assert/strict';
import { QualityController } from '../src/quality.js';

test('static screen on a healthy link still climbs out of saver', () => {
  const q = new QualityController({ level: 0, maxLevel: 5, auto: true }); q.lastChange = 0;   // fake clock starts at 0
  q.onSent(1, 3000, 0); q.onAck(1, 40);                 // one small frame, acked: link is healthy, nothing else to send
  let t = 1000, changed = null;
  for (; t <= 20000 && !changed; t += 500) changed = q.tick(t);
  assert.ok(changed, 'expected a climb');
  assert.equal(q.level, 1);
});

test('a climb that is punished doubles the wait before the next one', () => {
  const q = new QualityController({ level: 0, maxLevel: 5, auto: true }); q.lastChange = 0;   // fake clock starts at 0
  q.onSent(1, 3000, 0); q.onAck(1, 40);
  let t = 1000; while (!q.tick(t)) t += 500;            // climbs to 1
  assert.equal(q.level, 1);
  for (let i = 2; i < 9; i++) q.onSent(i, 40000, t + i);  // frames pile up without acks...
  q.gate(false, 1000, t + 1000); q.gate(true, 1000, t + 1050); q.gate(false, 1000, t + 1100);   // ...so the gate drops delta frames (twice, with a keyframe between): congestion
  const down = q.tick(t + 1500);
  assert.ok(down); assert.equal(q.level, 0);
  assert.equal(q.climbWait, 12000);
});

test('never climbs past maxLevel and never when auto is off', () => {
  const q = new QualityController({ level: 2, maxLevel: 2, auto: true }); q.lastChange = 0;   // fake clock starts at 0
  q.onSent(1, 3000, 0); q.onAck(1, 40);
  for (let t = 1000; t < 60000; t += 500) assert.equal(q.tick(t), null);
  const f = new QualityController({ level: 0, maxLevel: 5, auto: false }); f.lastChange = 0;
  for (let t = 1000; t < 60000; t += 500) assert.equal(f.tick(t), null);
});

test('a 150 ms path at 30 fps is allowed more frames in flight than a LAN', () => {
  const lan = new QualityController({ level: 3, auto: true }); lan.rttMin = 5;
  const wan = new QualityController({ level: 3, auto: true }); wan.rttMin = 150;
  assert.ok(wan._maxInflight() > lan._maxInflight());
  assert.ok(wan._maxInflight() <= 12);
});

test('laggy relay path (400 ms) with periodic bursts still climbs out of saver', () => {
  const q = new QualityController({ level: 0, maxLevel: 5, auto: true }); q.lastChange = 0;
  q.rttMin = 400; q.rtt = 400;
  let t = 1000, seq = 0, climbedAt = null;
  for (; t <= 60000 && climbedAt === null; t += 500) {
    q.onSent(++seq, 3000, t); q.onAck(seq, t + 400);              // a trickle of small frames, acked at 400 ms
    if (t % 12000 === 0) { for (let i = 0; i < 25; i++) q.onSent(++seq, 4000, t); q.gate(false, 1000, t); q.gate(true, 1000, t + 10); q.gate(false, 1000, t + 20); }   // a screen change every 12 s overruns the cap
    if (q.tick(t)) climbedAt = t;
  }
  assert.ok(climbedAt !== null && climbedAt <= 30000, 'climbed by ' + climbedAt);
});

test('the in-flight cap on a 400 ms path leaves room for a burst', () => {
  const q = new QualityController({ level: 2, auto: true }); q.rttMin = 400;
  assert.ok(q._maxInflight() >= 16);
});

/** Simulated link: fixed capacity plus propagation delay, FIFO queue. Returns the worst send-to-ack time after warm-up. */
function simulate({ capBps, propMs, frameBytes, fps, seconds, level = 1 }) {
  const q = new QualityController({ level, maxLevel: level, auto: true }); q.lastChange = 0;
  const events = []; let seq = 0, linkFree = 0, worst = 0, wantKey = false;
  // warm-up: small frames establish rttMin like a quiet screen would
  for (let i = 0; i < 5; i++) { const t = i * 100; q.onSent(++seq, 2000, t); events.push([t + propMs + (2000 * 8 / capBps) * 1000, seq, t]); }
  const step = Math.round(1000 / fps);
  for (let t = 1000; t < 1000 + seconds * 1000; t += 5) {
    while (events.length && events[0][0] <= t) { const [at, s, sentAt] = events.shift(); q.onAck(s, at); if (t > 6000) worst = Math.max(worst, at - sentAt); }
    q.tick(t);
    if (t % step < 5) {
      const key = wantKey; wantKey = false;                       // the encoder answers a keyframe request with a (bigger) keyframe
      const bytes = key ? frameBytes * 3 : frameBytes;
      const g = q.gate(key, bytes, t);
      if (g.needKeyframe) wantKey = true;
      if (g.send) {
        q.onSent(++seq, bytes, t);
        const start = Math.max(t, linkFree); linkFree = start + (bytes * 8 / capBps) * 1000;
        events.push([linkFree + propMs, seq, t]); events.sort((a, b) => a[0] - b[0]);
      }
    }
  }
  return worst;
}

test('a burst bigger than the link does not queue more than ~0.5 s of video', () => {
  const worst = simulate({ capBps: 1_500_000, propMs: 200, frameBytes: 30_000, fps: 24, seconds: 30 });
  assert.ok(worst < 400 + 500, 'worst send-to-ack ' + Math.round(worst) + ' ms');
});

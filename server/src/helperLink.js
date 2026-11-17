import net from 'node:net';
import { EventEmitter } from 'node:events';
import { patchAvcC } from './h264.js';

/** Client side of the helper's Unix socket. Frames: [1B type][4B BE len][payload].
 *  Emits: 'json' (obj), 'video' (Buffer payload), 'up', 'down'. Reconnects forever. */
export class HelperLink extends EventEmitter {
  constructor(sockPath) {
    super();
    this.sockPath = sockPath;
    this.sock = null;
    this.up = false;
    this.buf = Buffer.alloc(0);
    this.status = null;        // last helper status
    this.videoConfig = null;   // last videoConfig
    this._connect();
  }

  _connect() {
    const s = net.connect(this.sockPath);
    s.setNoDelay(true);
    s.on('connect', () => {
      this.sock = s; this.up = true; this.buf = Buffer.alloc(0);
      this.emit('up');
    });
    s.on('data', (d) => this._onData(d));
    const lost = () => {
      if (this.sock === s || !this.sock) {
        const was = this.up;
        this.up = false; this.sock = null; this.videoConfig = null;
        if (was) this.emit('down');
      }
      s.destroy();
      setTimeout(() => this._connect(), 1000).unref?.();
    };
    s.on('error', () => {});
    s.on('close', lost);
  }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) break;
      const type = this.buf[0];
      const payload = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);
      if (type === 2) this.emit('video', payload);
      else if (type === 1) {
        let j; try { j = JSON.parse(payload.toString('utf8')); } catch { continue; }
        if (j.t === 'status') this.status = j;
        else if (j.t === 'videoConfig') {
          if (j.desc) j.desc = patchAvcC(Buffer.from(j.desc, 'base64')).toString('base64');
          this.videoConfig = j;
        }
        this.emit('json', j);
      }
    }
  }

  send(obj) {
    if (!this.up || !this.sock) return false;
    const p = Buffer.from(JSON.stringify(obj));
    const h = Buffer.alloc(5); h[0] = 0x10; h.writeUInt32BE(p.length, 1);
    return this.sock.write(Buffer.concat([h, p]));
  }
}

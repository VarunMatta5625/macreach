import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Reads one line from the controlling terminal (/dev/tty), optionally with echo off.
 *  Never reads argv, env vars or stdin, so secrets can't leak through shell history or pipes. */
let ttyFd = null;
function tty() {
  if (ttyFd !== null) return ttyFd;
  try { ttyFd = fs.openSync('/dev/tty', 'r+'); }
  catch { process.stderr.write('This command needs an interactive terminal. Run it in Terminal.app yourself.\n'); process.exit(1); }
  return ttyFd;
}
const stty = (fd, arg) => spawnSync('stty', [arg], { stdio: [fd, 'ignore', 'ignore'] });
const restoreEcho = () => { if (ttyFd !== null) stty(ttyFd, 'echo'); };
process.on('exit', restoreEcho);
process.on('SIGINT', () => { restoreEcho(); try { fs.writeSync(2, '\nCancelled.\n'); } catch {} process.exit(130); });

export function prompt(label, { hidden = false } = {}) {
  const fd = tty();
  fs.writeSync(fd, label);
  if (hidden) stty(fd, '-echo');
  const chunks = []; const b = Buffer.alloc(1);
  try {
    for (;;) {
      const n = fs.readSync(fd, b, 0, 1, null);
      if (n === 0 || b[0] === 10 || b[0] === 13) break;
      chunks.push(b[0]);
      if (chunks.length > 4096) break;
    }
  } finally {
    if (hidden) { stty(fd, 'echo'); fs.writeSync(fd, '\n'); }
  }
  return Buffer.from(chunks).toString('utf8');
}

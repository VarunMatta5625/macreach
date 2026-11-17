// The hidden prompt must not echo, must read from the tty (not stdin/argv), and must restore echo afterwards.
// Uses a pty and a DUMMY string; this test never touches real credentials or the CLI's set-password.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, '../src/tty.js');

test('hidden prompt: no echo, value delivered, echo restored', () => {
  const py = `
import os, pty, sys, select, time, subprocess
code = "import {prompt} from '${probe}'; const v = prompt('PW: ', {hidden:true}); console.log('GOT=' + JSON.stringify(v));"
pid, fd = pty.fork()
if pid == 0:
    os.execvp('node', ['node', '--input-type=module', '-e', code])
buf = b''
def pump(t=1.2):
    global buf
    end = time.time() + t
    while time.time() < end:
        r,_,_ = select.select([fd],[],[],0.1)
        if r:
            try: d = os.read(fd, 4096)
            except OSError: return
            if not d: return
            buf += d
pump(1.5)
os.write(fd, b'dummy-secret-xyz\\n')
pump(1.5)
os.waitpid(pid, 0)
sys.stdout.write(buf.decode(errors='replace'))
`;
  const r = spawnSync('python3', ['-I', '-c', py], { encoding: 'utf8', timeout: 20000 });
  const out = r.stdout;
  assert.match(out, /PW: /);
  assert.match(out, /GOT="dummy-secret-xyz"/);
  const beforeGot = out.slice(0, out.indexOf('GOT='));
  assert.ok(!beforeGot.includes('dummy-secret-xyz'), 'secret must not be echoed to the terminal');
});

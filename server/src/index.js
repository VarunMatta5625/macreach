import fs from 'node:fs';
import { loadConfig } from './config.js';
import path from 'node:path';
import { CTL_SOCK, HELPER_SOCK, LOG_DIR, ensureDirs } from './paths.js';
import { HelperLink } from './helperLink.js';
import { createServer } from './server.js';

ensureDirs();

/** launchd appends to these files forever. Keep the last ~1 MB of any log over 5 MB, as <name>.1 (copy then truncate in place,
 *  because launchd keeps the file open). */
function rotateLogs() {
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!f.endsWith('.log')) continue;
      const p = path.join(LOG_DIR, f), st = fs.statSync(p);
      if (st.size <= 5 * 1024 * 1024) continue;
      const fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(1024 * 1024);
      fs.readSync(fd, buf, 0, buf.length, st.size - buf.length); fs.closeSync(fd);
      fs.writeFileSync(p + '.1', buf, { mode: 0o600 });
      fs.truncateSync(p, 0);
    }
  } catch {}
}
if (!process.env.MACREACH_DATA_DIR) { rotateLogs(); setInterval(rotateLogs, 60 * 60 * 1000).unref(); }
const config = loadConfig();

const helper = new HelperLink(HELPER_SOCK);
const { server, ctlServer } = createServer({ config, helper });

const port = Number(process.env.MACREACH_PORT || config.port);
server.listen(port, '127.0.0.1', () => {
  console.log(`[macreach] listening on 127.0.0.1:${port}  helper=${HELPER_SOCK}`);
});
try { fs.unlinkSync(CTL_SOCK); } catch {}
const oldMask = process.umask(0o077);
ctlServer.listen(CTL_SOCK, () => { try { fs.chmodSync(CTL_SOCK, 0o600); } catch {} });
process.umask(oldMask);
ctlServer.on('error', (e) => console.error('[macreach] ctl error', e.message));
server.on('error', (e) => { console.error('[macreach] server error', e.message); process.exit(1); });
process.on('uncaughtException', (e) => console.error('[macreach] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[macreach] unhandled', e));

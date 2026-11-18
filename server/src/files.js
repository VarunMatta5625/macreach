import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

/** File browsing / transfer over plain HTTP streams (never over the video WebSocket).
 *  Every path is resolved with realpath and must stay inside a configured root. */

async function realRoots(cfg) {
  const out = [];
  for (const r of cfg.files.roots) { try { out.push(await fsp.realpath(r)); } catch {} }
  return out;
}

export async function resolveInRoots(cfg, p, { mustExist = true } = {}) {
  if (typeof p !== 'string' || p.includes('\0')) throw httpErr(400, 'bad path');
  const roots = await realRoots(cfg);
  if (!roots.length) throw httpErr(403, 'no roots');
  const abs = path.resolve(p.startsWith('/') ? p : path.join(roots[0], p));
  let real;
  try { real = await fsp.realpath(abs); }
  catch (e) {
    if (mustExist) throw httpErr(404, 'not found');
    // for new files: resolve the parent
    const parent = await fsp.realpath(path.dirname(abs)).catch(() => { throw httpErr(404, 'not found'); });
    real = path.join(parent, path.basename(abs));
  }
  const ok = roots.some((r) => real === r || real.startsWith(r + path.sep));
  if (!ok) throw httpErr(403, 'outside allowed folders');
  return real;
}

export function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

export async function listDir(cfg, p) {
  const roots = await realRoots(cfg);
  const dir = await resolveInRoots(cfg, p || roots[0]);
  const st = await fsp.stat(dir);
  if (!st.isDirectory()) throw httpErr(400, 'not a directory');
  const names = await fsp.readdir(dir);
  const entries = [];
  await Promise.all(names.map(async (name) => {
    try {
      const s = await fsp.stat(path.join(dir, name));
      entries.push({ name, dir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, mtime: s.mtimeMs });
    } catch {}
  }));
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const parent = roots.includes(dir) ? null : path.dirname(dir);
  return { path: dir, parent, roots, entries };
}

const MIME = { '.txt': 'text/plain', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

export async function download(cfg, req, res, p) {
  const real = await resolveInRoots(cfg, p);
  const st = await fsp.stat(real);
  const base = path.basename(real);
  const disp = (n) => `attachment; filename="${n.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(n)}`;
  const cd = disp(base);
  if (st.isDirectory()) {
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': disp(base + '.zip'), 'Cache-Control': 'no-store' });
    const z = spawn('/usr/bin/zip', ['-qr', '-', '--', base], { cwd: path.dirname(real), stdio: ['ignore', 'pipe', 'ignore'] });
    res.on('close', () => z.kill());
    z.stdout.pipe(res);
    return;
  }
  let start = 0, end = st.size - 1, status = 200;
  const headers = { 'Content-Type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream', 'Content-Disposition': cd, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = +m[1]; if (m[2]) end = Math.min(+m[2], end); } else { start = Math.max(0, st.size - +m[2]); }
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  await pipeline(fs.createReadStream(real, { start, end }), res).catch(() => {});
}

function sanitizeName(name) {
  let n = path.basename(String(name || 'upload')).replace(/[\0/\\:]/g, '_').replace(/^\.+/, '_').slice(0, 200);
  return n || 'upload';
}

export async function upload(cfg, req, name, dir) {
  const target = dir ? await resolveInRoots(cfg, dir) : cfg.files.uploadDir;
  await fsp.mkdir(target, { recursive: true });
  if (dir) { const st = await fsp.stat(target); if (!st.isDirectory()) throw httpErr(400, 'not a directory'); }
  const real = await fsp.realpath(target);
  const clean = sanitizeName(name);
  const ext = path.extname(clean), stem = clean.slice(0, clean.length - ext.length);
  const max = cfg.files.maxUploadGB * 1024 ** 3;
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > max) throw httpErr(413, 'too large');
  let final = path.join(real, clean);
  for (let i = 1; ; i++) {
    try { await fsp.access(final); final = path.join(real, `${stem} (${i})${ext}`); } catch { break; }
  }
  const tmp = path.join(real, `.${path.basename(final)}.mrpart`);
  const ws = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o644 });
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > max) req.destroy(new Error('too large')); });
  try { await pipeline(req, ws); } catch (e) { await fsp.unlink(tmp).catch(() => {}); throw httpErr(e.message === 'too large' ? 413 : 400, 'upload failed'); }
  await fsp.rename(tmp, final);
  return { path: final, size };
}

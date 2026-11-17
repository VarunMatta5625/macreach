import fs from 'node:fs';
import { AUDIT_FILE } from './paths.js';

const MAX = 5 * 1024 * 1024;

export function audit(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  try {
    try { if (fs.statSync(AUDIT_FILE).size > MAX) fs.renameSync(AUDIT_FILE, AUDIT_FILE + '.1'); } catch {}
    fs.appendFileSync(AUDIT_FILE, line, { mode: 0o600 });
  } catch (e) { console.error('audit write failed', e.message); }
}

export function readAudit(limit = 50) {
  try {
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch { return []; }
}

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HOME = os.homedir();
export const DATA_DIR = process.env.MACREACH_DATA_DIR || path.join(HOME, 'Library', 'Application Support', 'MacReach');
export const LOG_DIR = path.join(HOME, 'Library', 'Logs', 'MacReach');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
export const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
export const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
export const CTL_SOCK = process.env.MACREACH_CTL_SOCK || path.join(DATA_DIR, 'ctl.sock');
export const HELPER_SOCK = process.env.MACREACH_HELPER_SOCK || path.join(DATA_DIR, 'helper.sock');
export const WEB_DIR = process.env.MACREACH_WEB_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DATA_DIR, 0o700); } catch {}
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Tiny structured-ish logger. Single line per event, ISO timestamp,
// level, scope, message. Production code reads this in `journalctl`/
// `docker logs`; dev reads it in the terminal that ran `npm run web`.
//
// Also mirrors every line into a rolling-window file at data/server.log
// (last ~LOG_FILE_MAX_LINES lines, plain text, no color codes). This
// gives AI / debugging tools a stable place to scan for slow APIs and
// recent errors without needing journalctl access.
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_FILE = join(__dirname, '..', 'data', 'server.log');
const LOG_FILE_MAX_LINES = 2000;
// How often to trim. Trimming reads + rewrites the whole file, so we don't
// do it on every line — just every TRIM_INTERVAL appends. With ~2k cap and
// 100-line interval, the file may temporarily grow to ~2.1k lines.
const LOG_TRIM_INTERVAL = 100;
let _appendsSinceTrim = 0;
let _logDirReady = false;
const ensureLogDir = () => {
  if (_logDirReady) return;
  try {
    const dir = dirname(LOG_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    _logDirReady = true;
  } catch { /* non-fatal — file logging is best-effort */ }
};
const trimLogFile = () => {
  try {
    if (!existsSync(LOG_FILE)) return;
    // Cheap pre-check: if file is small, no point reading it.
    const sz = statSync(LOG_FILE).size;
    if (sz < LOG_FILE_MAX_LINES * 80) return; // ~80 bytes/line lower bound
    const content = readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n');
    if (lines.length <= LOG_FILE_MAX_LINES) return;
    const trimmed = lines.slice(lines.length - LOG_FILE_MAX_LINES).join('\n');
    writeFileSync(LOG_FILE, trimmed);
  } catch { /* non-fatal */ }
};
const appendLogFile = (line) => {
  ensureLogDir();
  try {
    appendFileSync(LOG_FILE, line + '\n');
    if (++_appendsSinceTrim >= LOG_TRIM_INTERVAL) {
      _appendsSinceTrim = 0;
      trimLogFile();
    }
  } catch { /* non-fatal */ }
};

const LEVEL_COLORS = {
  info:  '\x1b[36m',  // cyan
  warn:  '\x1b[33m',  // yellow
  err:   '\x1b[31m',  // red
  ok:    '\x1b[32m',  // green
};
const RESET = '\x1b[0m';
const ENABLE_COLOR = process.stdout.isTTY;

const fmtArg = (a) => {
  if (a == null) return String(a);
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
};

const emit = (level, scope, ...parts) => {
  const ts = new Date().toISOString();
  const pad = level.padEnd(4);
  const colored = ENABLE_COLOR
    ? `${LEVEL_COLORS[level] || ''}${pad}${RESET}`
    : pad;
  const tag = scope ? `[${scope}] ` : '';
  const plain = `${ts} ${pad} ${tag}${parts.map(fmtArg).join(' ')}`;
  // eslint-disable-next-line no-console
  console.log(`${ts} ${colored} ${tag}${parts.map(fmtArg).join(' ')}`);
  appendLogFile(plain);
};

export const log = {
  info: (scope, ...parts) => emit('info', scope, ...parts),
  warn: (scope, ...parts) => emit('warn', scope, ...parts),
  err:  (scope, ...parts) => emit('err',  scope, ...parts),
  ok:   (scope, ...parts) => emit('ok',   scope, ...parts),
};

export default log;

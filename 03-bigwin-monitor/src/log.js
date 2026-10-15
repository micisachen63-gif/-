import fs from 'node:fs';
import path from 'node:path';
import { fmtStamp, redact } from './util.js';

/**
 * Size-capped logger: when the file exceeds maxBytes it is rotated to .1 (… .keep), oldest dropped.
 * Every line passes through redact() so a token can never land in a log by accident.
 */
export function createLogger(file, { maxBytes = 5 * 1024 * 1024, keep = 3, echo = true, tag = '' } = {}) {
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  let checkCounter = 0;
  function rotateIfNeeded() {
    if (!file) return;
    if (++checkCounter % 20 !== 1) return;
    try {
      if (fs.statSync(file).size < maxBytes) return;
    } catch { return; }
    try {
      for (let i = keep - 1; i >= 1; i--) {
        if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      }
      fs.renameSync(file, `${file}.1`);
      if (fs.existsSync(`${file}.${keep + 1}`)) fs.unlinkSync(`${file}.${keep + 1}`);
    } catch { /* another process may hold it; try again later */ }
  }
  function write(level, parts) {
    const msg = parts.map((p) => (p instanceof Error ? (p.stack || p.message) : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    const line = redact(`[${fmtStamp()}] ${level}${tag ? ' ' + tag : ''} ${msg}`);
    if (echo) (level === 'ERROR' ? process.stderr : process.stdout).write(line + '\n');
    if (!file) return;
    rotateIfNeeded();
    try { fs.appendFileSync(file, line + '\n'); } catch { /* never crash on logging */ }
  }
  const logger = {
    info: (...p) => write('INFO', p),
    warn: (...p) => write('WARN', p),
    error: (...p) => write('ERROR', p),
    child: (childTag) => createLoggerChild(logger, childTag),
  };
  logger._write = write;
  return logger;
}

function createLoggerChild(parent, childTag) {
  const wrap = (level) => (...p) => parent[level](`[${childTag}]`, ...p);
  return { info: wrap('info'), warn: wrap('warn'), error: wrap('error'), child: (t) => createLoggerChild(parent, `${childTag}/${t}`) };
}

export const silentLogger = { info() {}, warn() {}, error() {}, child() { return silentLogger; } };

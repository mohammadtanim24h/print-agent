import log from 'electron-log/main';
import { redactString, redactValue } from './redact';

/**
 * Structured logger facade over electron-log: JSON lines, 5 MiB rotation
 * (electron-log archives to <file>.old), redaction applied to every message
 * before it reaches any transport. Scope names, never payloads, identify
 * modules.
 */
export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface LogLine {
  readonly ts: string;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly module: string;
  readonly message: string;
}

const FIVE_MIB = 5 * 1024 * 1024;

// Ambient by design: a process-wide in-memory diagnostics seam (not a hidden
// singleton dependency — code that needs recent logs takes the accessor).
const RING_CAP = 500;
const ring: LogLine[] = [];

/** Diagnostics seam: newest-last ring of redacted lines for the renderer. */
export function pushRecentLogLine(line: LogLine): void {
  ring.push(line);
  if (ring.length > RING_CAP) ring.shift();
}

export function getRecentLogLines(): readonly LogLine[] {
  return [...ring];
}

export function setupLogging(): void {
  log.initialize();
  // Redact in the hook chain so file AND console transports see clean data.
  log.hooks.push((message) => {
    message.data = message.data.map((d) => redactValue(d));
    return message;
  });
  log.transports.file.maxSize = FIVE_MIB;
  // Structured JSON lines for machine ingestion; keep console human-readable
  // in dev (electron-log default) — the packaged app ships file transport only.
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] [{scope}] {text}';
}

export function createLogger(scope: string): Logger {
  const scoped = log.scope(scope);
  const emit = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: unknown,
  ): void => {
    // The ring is renderer-visible, and the electron-log hook chain runs later
    // (during transport dispatch) — so redact here explicitly (CLAUDE.md 6/7).
    pushRecentLogLine({
      ts: new Date().toISOString(),
      level,
      module: scope,
      message: redactString(message),
    });
    if (data === undefined) {
      scoped[level](message);
    } else {
      scoped[level](message, data);
    }
  };
  return {
    debug: (message, data) => {
      emit('debug', message, data);
    },
    info: (message, data) => {
      emit('info', message, data);
    },
    warn: (message, data) => {
      emit('warn', message, data);
    },
    error: (message, data) => {
      emit('error', message, data);
    },
  };
}

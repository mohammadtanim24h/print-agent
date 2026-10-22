import log from 'electron-log/main';
import { redactValue } from './redact';

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

const FIVE_MIB = 5 * 1024 * 1024;

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

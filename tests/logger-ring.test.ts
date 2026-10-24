import { describe, expect, it } from 'vitest';
import {
  pushRecentLogLine,
  getRecentLogLines,
  createLogger,
  type LogLine,
} from '../src/main/services/logger/logger';

describe('log ring buffer', () => {
  it('keeps the newest lines in order, capped', () => {
    for (let i = 0; i < 600; i++) {
      pushRecentLogLine({
        ts: new Date(i).toISOString(),
        level: 'info',
        module: 't',
        message: `m${String(i)}`,
      });
    }
    const lines: readonly LogLine[] = getRecentLogLines();
    expect(lines.length).toBe(500);
    expect(lines[lines.length - 1]?.message).toBe('m599');
    expect(lines[0]?.message).toBe('m100');
  });
});

describe('emit → ring redaction', () => {
  it('stores emit() lines redacted, never raw secrets', () => {
    const log = createLogger('ring-test');
    log.info('auth header prepared: Bearer secret-token-123');
    const lines = getRecentLogLines();
    // The ring may already be at cap from earlier tests (shared module state),
    // so length alone can't prove the push — the newest line being ours does.
    const last = lines[lines.length - 1];
    expect(last?.module).toBe('ring-test');
    expect(last?.message).not.toContain('secret-token-123');
    expect(last?.message).toContain('[REDACTED:token]');
  });
});

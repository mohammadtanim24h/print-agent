import { describe, expect, it } from 'vitest';
import {
  pushRecentLogLine,
  getRecentLogLines,
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

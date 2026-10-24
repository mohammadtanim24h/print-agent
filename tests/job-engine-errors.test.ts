import { describe, expect, it } from 'vitest';
import { decodeStoredError, encodeStoredError } from '../src/main/jobs/engine';

describe('stored lastError codec', () => {
  it('round-trips code and message', () => {
    const stored = encodeStoredError('connect_timeout', 'connect timed out after 3000ms');
    expect(stored).toBe('connect_timeout: connect timed out after 3000ms');
    expect(decodeStoredError(stored)).toEqual({
      code: 'connect_timeout',
      message: 'connect timed out after 3000ms',
    });
  });

  it('splits on the first ": " only — messages may contain the separator', () => {
    expect(decodeStoredError(encodeStoredError('write_failed', 'socket: broken pipe'))).toEqual({
      code: 'write_failed',
      message: 'socket: broken pipe',
    });
  });

  it('degrades gracefully on degenerate/legacy input', () => {
    expect(decodeStoredError('no separator here')).toEqual({ code: 'failed', message: 'no separator here' });
    expect(decodeStoredError(': leading separator')).toEqual({ code: 'failed', message: ': leading separator' });
    expect(decodeStoredError('')).toEqual({ code: 'failed', message: 'unknown error' });
  });
});

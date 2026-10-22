import { describe, expect, it } from 'vitest';
import { redactString, redactValue } from '../src/main/services/logger/redact';

describe('redactString', () => {
  it('redacts Bearer tokens', () => {
    expect(redactString('auth: Bearer abc.def.ghi-ok')).toBe('auth: [REDACTED:token]');
  });

  it('redacts JWTs standalone', () => {
    expect(redactString('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_nonce')).toBe('[REDACTED:token]');
  });

  it('redacts key-ish JSON fields with values', () => {
    expect(redactString('{"deviceKey":"a1b2c3","password":"hunter2"}')).toBe(
      '{[REDACTED:field]:[REDACTED:value],[REDACTED:field]:[REDACTED:value]}',
    );
  });

  it('redacts email addresses (PII)', () => {
    expect(redactString('contact john.doe@example.co.uk now')).toBe('contact [REDACTED:email] now');
  });

  it('redacts long hex secrets', () => {
    expect(redactString('key=0123456789abcdef0123456789abcdef')).toBe('key=[REDACTED:hex-secret]');
  });

  it('leaves normal receipt text untouched', () => {
    const line = 'Order #42 — 2x Margherita, table 7, total €19.80';
    expect(redactString(line)).toBe(line);
  });

  it('leaves ordinary technical strings untouched', () => {
    expect(redactString('wss://saas.example.com/api/agent/ws')).toBe(
      'wss://saas.example.com/api/agent/ws',
    );
  });
});

describe('redactValue', () => {
  it('deep-redacts objects and arrays', () => {
    const input = {
      token: 'super-secret-value',
      nested: { email: 'a@b.co' },
      list: ['Bearer xyz', 'safe'],
      n: 5,
    };
    expect(redactValue(input)).toEqual({
      token: '[REDACTED:value]',
      nested: { email: '[REDACTED:email]' },
      list: ['[REDACTED:token]', 'safe'],
      n: 5,
    });
  });

  it('secret-named string fields have values redacted, key kept', () => {
    expect(redactValue({ deviceKey: 'x' })).toEqual({ deviceKey: '[REDACTED:value]' });
  });

  it('caps traversal depth and input size', () => {
    const deep: Record<string, unknown> = { leaf: 'ok' };
    let cur = deep;
    for (let i = 0; i < 50; i++) {
      cur.child = {};
      cur = cur.child as Record<string, unknown>;
    }
    const out = redactValue(deep) as Record<string, unknown>;
    // deep chains are cut off with a marker, never a crash
    let depth = 0;
    let node: unknown = out;
    while (node && typeof node === 'object' && 'child' in node) {
      node = (node as Record<string, unknown>).child;
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(9);
    expect(typeof node).toBe('string'); // truncation marker
  });

  it('handles cyclic structures without hanging', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redactValue(a)).not.toThrow();
  });
});

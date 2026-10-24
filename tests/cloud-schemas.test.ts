import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  ConfigUpdateSchema,
  PairResponseSchema,
  PrintJobEnvelopeSchema,
  parseServerMessage,
} from '../src/main/cloud-client/schemas';
import { makePairResponse } from './helpers/cloud';
import { canonicalJson } from '../src/main/cloud-client/canonical-json';
import {
  verifyEnvelopeSig,
  decodeEd25519PublicKey,
  generateDeviceKeyPair,
} from '../src/main/cloud-client/envelope-sig';
import { makeConfig, makeConfigRaw, makeSignedEnvelope, PRINTER_ID } from './helpers/cloud';

describe('canonicalJson', () => {
  it('sorts keys recursively and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 0, y: null }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":null,"z":0}]},"b":1}',
    );
  });

  it('round-trips through JSON.parse', () => {
    const value = { z: 1, a: ['x', { m: 2.5, n: true }] };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });
});

describe('PrintJobEnvelopeSchema (contract §6 envelope matrix)', () => {
  it('accepts a valid signed envelope — sig verifies over the RAW wire job', () => {
    const { envelope, publicKeyRaw } = makeSignedEnvelope();
    const parsed = PrintJobEnvelopeSchema.parse(envelope);
    // Verification must use the untouched wire form: schema defaults
    // (emphasis/align/totals…) change the canonical bytes otherwise.
    expect(verifyEnvelopeSig(envelope.job, parsed.sig, publicKeyRaw)).toBe(true);
    expect(verifyEnvelopeSig(parsed.job, parsed.sig, publicKeyRaw)).toBe(false); // normalized form ≠ signed form
  });

  it('rejects an unknown envelope_version major with a structured classification', () => {
    const { envelope } = makeSignedEnvelope({ envelope_version: 2 });
    const msg = parseServerMessage(envelope);
    expect(msg).toMatchObject({ kind: 'unsupported_version', envelopeVersion: 2 });
  });

  it('classifies a missing job field as malformed', () => {
    const { envelope } = makeSignedEnvelope();
    const rest = { ...envelope };
    delete rest.job;
    expect(parseServerMessage(rest).kind).toBe('malformed');
  });

  it('rejects an oversized payload (> 200 lines)', () => {
    const { envelope } = makeSignedEnvelope({
      job: {
        payload: { lines: Array.from({ length: 201 }, (_, i) => ({ text: `line ${String(i)}` })) },
      },
    });
    expect(parseServerMessage(envelope).kind).toBe('malformed');
  });

  it('rejects unknown fields inside the job payload (strict)', () => {
    const { envelope } = makeSignedEnvelope({
      job: { sneaky: true },
    });
    expect(parseServerMessage(envelope).kind).toBe('malformed');
  });

  it('rejects a non-base64url / wrong-length signature', () => {
    const { envelope } = makeSignedEnvelope({ sig: 'not-a-real-sig!!' });
    const parsed = PrintJobEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(false);
  });

  it('rejects a tampered job (sig no longer matches)', () => {
    const { envelope, publicKeyRaw } = makeSignedEnvelope();
    const parsed = PrintJobEnvelopeSchema.parse(envelope);
    const rawJob = envelope.job as Record<string, unknown>;
    const tampered = { ...rawJob, priority: 1 };
    expect(verifyEnvelopeSig(tampered, parsed.sig, publicKeyRaw)).toBe(false);
  });

  it('rejects a signature made by a different key', () => {
    const { envelope } = makeSignedEnvelope();
    const parsed = PrintJobEnvelopeSchema.parse(envelope);
    const otherKey = generateDeviceKeyPair();
    expect(
      verifyEnvelopeSig(envelope.job, parsed.sig, decodeEd25519PublicKey(otherKey.publicKeyRaw)),
    ).toBe(false);
  });
});

describe('ConfigUpdateSchema', () => {
  it('accepts a valid config snapshot', () => {
    expect(ConfigUpdateSchema.parse(makeConfig(41)).config_version).toBe(41);
  });

  it('rejects an invalid tcp transport address', () => {
    const config = makeConfigRaw(2, {
      printers: [
        {
          printer_id: PRINTER_ID,
          name: 'Bad',
          transport: {
            kind: 'tcp_raw',
            host: '192.168.1.87 admin',
            port: 9100,
            connect_timeout_ms: 3000,
            write_timeout_ms: 5000,
          },
          station: 'kitchen',
          copies_default: 1,
          codepage: 'cp437',
          cut_default: 'partial',
          duplicate_policy: 'ask_operator',
          status_polling: 'off',
        },
      ],
    });
    expect(ConfigUpdateSchema.safeParse(config).success).toBe(false);
  });

  it('rejects unknown transport kinds and unknown printer fields', () => {
    const base = makeConfig(2);
    const unknownKind = makeConfigRaw(2, {
      printers: [{ ...base.printers[0], transport: { kind: 'carrier_pigeon' } }],
    });
    expect(ConfigUpdateSchema.safeParse(unknownKind).success).toBe(false);
    const unknownField = makeConfigRaw(2, {
      printers: [{ ...base.printers[0], extra: 1 }],
    });
    expect(ConfigUpdateSchema.safeParse(unknownField).success).toBe(false);
  });
});

describe('parseServerMessage classification', () => {
  it('classifies revoke and ping', () => {
    expect(parseServerMessage({ type: 'revoke', reason: 'manager_initiated' })).toEqual({
      kind: 'revoke',
      reason: 'manager_initiated',
    });
    expect(parseServerMessage({ type: 'ping' }).kind).toBe('ping');
  });

  it('classifies config_update envelopes', () => {
    const msg = parseServerMessage({ envelope_version: 1, ...makeConfig(7) });
    expect(msg).toMatchObject({ kind: 'config_update', config: { config_version: 7 } });
  });

  it('classifies garbage as malformed without throwing', () => {
    expect(parseServerMessage('nope').kind).toBe('malformed');
    expect(parseServerMessage({ type: 'print_job', job: null }).kind).toBe('malformed');
  });
});

describe('PairResponseSchema', () => {
  it('rejects a non-32-byte server signing key', () => {
    const bad = { ...makePairResponse(), server_signing_pubkey: 'AAAA' };
    expect(PairResponseSchema.safeParse(bad).success).toBe(false);
  });
});

describe('ApiErrorSchema', () => {
  it('parses the RFC 7807-style error body', () => {
    const parsed = ApiErrorSchema.parse({ error: { code: 'pairing_code_used', message: 'x' } });
    expect(parsed.error.code).toBe('pairing_code_used');
  });
});

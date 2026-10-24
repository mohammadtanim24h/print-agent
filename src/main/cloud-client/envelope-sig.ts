import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson } from './canonical-json';

/**
 * Envelope signature verification (api-contract §2, ADR-7): the server signs
 * `canonical_json(job)` with an ed25519 signing key; the agent verifies against
 * the public key pinned at pairing (GET /server-keys). Mitigates a compromised
 * backend instance injecting jobs (threat T2/T4).
 */

const ED25519_RAW_LENGTH = 32;

/** Raw 32-byte ed25519 public key, base64url (no padding) — the wire format for
 *  `server_signing_pubkey` / `keys[].public_key`. */
export function encodeEd25519PublicKey(raw: Uint8Array): string {
  if (raw.length !== ED25519_RAW_LENGTH) {
    throw new TypeError(`ed25519 public key must be ${String(ED25519_RAW_LENGTH)} bytes`);
  }
  return Buffer.from(raw).toString('base64url');
}

export function decodeEd25519PublicKey(encoded: string): Uint8Array {
  const buf = Buffer.from(encoded, 'base64url');
  if (buf.length !== ED25519_RAW_LENGTH) {
    throw new TypeError(`ed25519 public key must be ${String(ED25519_RAW_LENGTH)} bytes`);
  }
  return new Uint8Array(buf);
}

export function generateDeviceKeyPair(): { privateKeyPkcs8: string; publicKeyRaw: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKeyRaw: encodeEd25519PublicKey(new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-ED25519_RAW_LENGTH))),
  };
}

// RFC 8410 SPKI prefix for ed25519 (algorithm OID 1.3.101.112) — wraps the raw
// 32-byte key so node:crypto can import it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function importRawPublicKey(raw: Uint8Array): KeyObject {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  });
}

/** Verify an envelope's `sig` over canonical_json(job). Never throws on a bad
 *  signature — returns false; throw is reserved for a malformed pinned key. */
export function verifyEnvelopeSig(job: unknown, sigBase64Url: string, pinnedPubKeyRaw: Uint8Array): boolean {
  const key = importRawPublicKey(pinnedPubKeyRaw);
  const data = Buffer.from(canonicalJson(job), 'utf8');
  let sig: Buffer;
  try {
    sig = Buffer.from(sigBase64Url, 'base64url');
  } catch {
    return false;
  }
  return verify(null, data, key, sig);
}

/** Test/server-side helper: produce a signature the way the SaaS does. */
export function signJobForTest(job: unknown, privateKey: KeyObject): string {
  return sign(null, Buffer.from(canonicalJson(job), 'utf8'), privateKey).toString('base64url');
}

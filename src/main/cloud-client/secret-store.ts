import { z } from 'zod';
import { CloudError } from './errors';

/**
 * Credential storage (CLAUDE.md rule 6, threat model T1): every secret field
 * is encrypted with Electron `safeStorage` (DPAPI-backed on Windows) before
 * it touches disk. If OS-level encryption is unavailable the store fails
 * closed — `save()` throws and nothing is written, plaintext or otherwise.
 * The store never returns secrets to the renderer and never logs values.
 */

/** Minimal key/value surface so the store is testable and the backing store
 *  (settings JSON file or the local SQLite `identity` table) is a wiring
 *  decision made in main.ts composition, not here. */
export interface SecretKv {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/** The subset of Electron's safeStorage this module relies on. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface IdentitySecrets {
  readonly deviceId: string;
  readonly deviceToken: string;
  readonly refreshToken: string;
  /** Device ed25519 keypair: PKCS#8 DER (base64url) private, raw (base64url) public. */
  readonly devicePrivateKey: string;
  readonly devicePublicKey: string;
  /** Server signing public key pinned at pairing (raw, base64url). */
  readonly serverSigningPubkey: string;
  readonly tenantId: string;
  readonly restaurantId: string;
}

const IdentitySchema = z.strictObject({
  deviceId: z.uuid(),
  deviceToken: z.string().min(1).max(2048),
  refreshToken: z.string().min(1).max(2048),
  devicePrivateKey: z.string().min(1).max(512),
  devicePublicKey: z.string().min(1).max(128),
  serverSigningPubkey: z.string().min(1).max(128),
  tenantId: z.uuid(),
  restaurantId: z.uuid(),
});

const KV_PREFIX = 'cloud.';
const FIELDS = [
  'deviceId',
  'deviceToken',
  'refreshToken',
  'devicePrivateKey',
  'devicePublicKey',
  'serverSigningPubkey',
  'tenantId',
  'restaurantId',
] as const;

export interface SecretStore {
  /** Parsed identity, or null when the agent is unpaired. Throws
   *  CloudError('secure_storage_unavailable') if stored blobs cannot be
   *  decrypted (OS user context changed / corrupted). */
  load(): IdentitySecrets | null;
  /** Fails closed when safeStorage is unavailable. */
  save(secrets: IdentitySecrets): void;
  /** Wipes every stored credential (revocation / re-pairing). */
  clear(): void;
}

export function createSafeStorageSecretStore(kv: SecretKv, safeStorage: SafeStorageLike): SecretStore {
  function encrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new CloudError('secure_storage_unavailable', 'refusing to persist secrets without OS-level encryption');
    }
    return safeStorage.encryptString(value).toString('base64');
  }

  function decrypt(stored: string, field: string): string {
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch {
      throw new CloudError('secure_storage_unavailable', `cannot decrypt stored ${field}`);
    }
  }

  return {
    load() {
      const parts: Partial<Record<(typeof FIELDS)[number], string>> = {};
      for (const field of FIELDS) {
        const stored = kv.get(KV_PREFIX + field);
        if (stored === null) return null; // any missing field ⇒ unpaired (written atomically together)
        parts[field] = decrypt(stored, field);
      }
      const parsed = IdentitySchema.safeParse(parts);
      if (!parsed.success) {
        throw new CloudError('secure_storage_unavailable', 'stored identity failed validation');
      }
      return parsed.data;
    },
    save(secrets) {
      const parsed = IdentitySchema.parse(secrets);
      // Encrypt everything first: if safeStorage is unavailable we throw
      // before a single field hits the kv, never a partial/plaintext write.
      const encrypted = new Map<string, string>();
      for (const field of FIELDS) {
        encrypted.set(KV_PREFIX + field, encrypt(parsed[field]));
      }
      for (const [key, value] of encrypted) kv.set(key, value);
    },
    clear() {
      for (const field of FIELDS) kv.delete(KV_PREFIX + field);
    },
  };
}

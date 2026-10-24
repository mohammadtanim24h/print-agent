import { z } from 'zod';
import { CloudError } from './errors';

/**
 * Credential storage (CLAUDE.md rule 6, threat model T1): the whole identity
 * is encrypted with Electron `safeStorage` (DPAPI-backed on Windows) and
 * persisted as ONE record before it touches disk. If OS-level encryption is
 * unavailable the store fails closed — `save()` throws and nothing is written,
 * plaintext or otherwise. The store never returns secrets to the renderer and
 * never logs values.
 *
 * The single-record layout is load-bearing for refresh rotation (§7 note 8):
 * a rotation rewrites both token fields, and a partial write (old refresh
 * token + new access token, or vice versa) would replay a superseded token
 * after a crash — which the server treats as theft and REVOKES the device.
 * One key ⇒ one all-or-nothing kv write (the settings backing store is
 * tmp+rename atomic).
 */

/** Minimal key/value surface so the store is testable and the backing store
 *  (settings JSON file or the local SQLite `identity` table) is a wiring
 *  decision made in main.ts composition, not here. Per-key writes MUST be
 *  atomic (all-or-nothing) — see the single-record note above. */
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

const IDENTITY_KV_KEY = 'cloud.identity';

export interface SecretStore {
  /** Parsed identity, or null when the agent is unpaired. Throws
   *  CloudError('secure_storage_unavailable') if the stored blob cannot be
   *  decrypted (OS user context changed / corrupted). */
  load(): IdentitySecrets | null;
  /** Fails closed when safeStorage is unavailable; writes one atomic record. */
  save(secrets: IdentitySecrets): void;
  /** Wipes every stored credential (revocation / re-pairing). */
  clear(): void;
}

export function createSafeStorageSecretStore(
  kv: SecretKv,
  safeStorage: SafeStorageLike,
): SecretStore {
  function encrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new CloudError(
        'secure_storage_unavailable',
        'refusing to persist secrets without OS-level encryption',
      );
    }
    return safeStorage.encryptString(value).toString('base64');
  }

  return {
    load() {
      const stored = kv.get(IDENTITY_KV_KEY);
      if (stored === null) return null;
      let plain: string;
      try {
        plain = safeStorage.decryptString(Buffer.from(stored, 'base64'));
      } catch {
        throw new CloudError('secure_storage_unavailable', 'cannot decrypt stored identity');
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(plain) as unknown;
      } catch {
        throw new CloudError('secure_storage_unavailable', 'stored identity is not valid JSON');
      }
      const parsed = IdentitySchema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new CloudError('secure_storage_unavailable', 'stored identity failed validation');
      }
      return parsed.data;
    },
    save(secrets) {
      const parsed = IdentitySchema.parse(secrets);
      // Encrypt the whole record first: if safeStorage is unavailable we throw
      // before anything hits the kv, never a partial/plaintext write.
      kv.set(IDENTITY_KV_KEY, encrypt(JSON.stringify(parsed)));
    },
    clear() {
      kv.delete(IDENTITY_KV_KEY);
    },
  };
}

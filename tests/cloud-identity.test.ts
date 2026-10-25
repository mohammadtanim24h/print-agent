import { describe, expect, it } from 'vitest';
import { createSafeStorageSecretStore } from '../src/main/cloud-client/secret-store';
import { pairDevice } from '../src/main/cloud-client/pairing';
import { CloudError } from '../src/main/cloud-client/errors';
import {
  FakeSafeStorage,
  FakeTransport,
  MemoryKv,
  makeB64Url32,
  makePairResponse,
  makeSecrets,
} from './helpers/cloud';

/** Overwrites the stored identity record with an encryptable-but-invalid plaintext. */
function storageSetCorrupted(kv: MemoryKv, storage: FakeSafeStorage, plain: string): void {
  kv.set('cloud.identity', storage.encryptString(plain).toString('base64'));
}

describe('safeStorage-backed secret store', () => {
  it('round-trips the identity through encryption', () => {
    const kv = new MemoryKv();
    const storage = new FakeSafeStorage();
    const store = createSafeStorageSecretStore(kv, storage);
    expect(store.load()).toBeNull();
    const secrets = makeSecrets();
    store.save(secrets);
    // Nothing on disk is plaintext.
    for (const value of kv.map.values()) {
      expect(value.startsWith('enc:')).toBe(false); // values are base64 of the encrypted blob
      expect(value).not.toContain('device-token-abc');
    }
    expect(store.load()).toEqual(secrets);
  });

  it('fails closed when OS-level encryption is unavailable: throws, writes nothing', () => {
    const kv = new MemoryKv();
    const storage = new FakeSafeStorage();
    storage.available = false;
    const store = createSafeStorageSecretStore(kv, storage);
    expect(() => {
      store.save(makeSecrets());
    }).toThrow(CloudError);
    expect(() => {
      store.save(makeSecrets());
    }).toThrow(/secure_storage_unavailable/);
    expect(kv.map.size).toBe(0);
  });

  it('throws (never returns garbage) when stored blobs cannot be decrypted', () => {
    const kv = new MemoryKv();
    const storage = new FakeSafeStorage();
    const store = createSafeStorageSecretStore(kv, storage);
    store.save(makeSecrets());
    storage.corruption = 'decrypt';
    expect(() => store.load()).toThrow(/secure_storage_unavailable/);
  });

  it('persists the identity as a single atomic record (§7 note 8: no partial token pair)', () => {
    const kv = new MemoryKv();
    const store = createSafeStorageSecretStore(kv, new FakeSafeStorage());
    store.save(makeSecrets());
    // One key ⇒ one all-or-nothing kv write; a crash can never leave a mixed
    // old/new token pair on disk.
    expect([...kv.map.keys()]).toEqual(['cloud.identity']);
    store.save(makeSecrets({ deviceToken: 'token-v2', refreshToken: 'refresh-v2' }));
    expect([...kv.map.keys()]).toEqual(['cloud.identity']);
    expect(store.load()?.refreshToken).toBe('refresh-v2');
  });

  it('treats a missing record as unpaired', () => {
    const kv = new MemoryKv();
    const store = createSafeStorageSecretStore(kv, new FakeSafeStorage());
    store.save(makeSecrets());
    kv.delete('cloud.identity');
    expect(store.load()).toBeNull();
  });

  it('rejects a stored identity that fails validation', () => {
    const kv = new MemoryKv();
    const store = createSafeStorageSecretStore(kv, new FakeSafeStorage());
    // save() validates its input…
    expect(() => {
      store.save(makeSecrets({ deviceId: 'not-a-uuid' }));
    }).toThrow();
    expect(kv.map.size).toBe(0);
    // …so simulate on-disk corruption instead:
    store.save(makeSecrets());
    const corrupted = JSON.stringify({ ...makeSecrets(), deviceId: 'not-a-uuid' });
    storageSetCorrupted(kv, new FakeSafeStorage(), corrupted);
    expect(() => store.load()).toThrow(/secure_storage_unavailable/);
  });

  it('rejects a stored record that is not valid JSON', () => {
    const kv = new MemoryKv();
    const storage = new FakeSafeStorage();
    const store = createSafeStorageSecretStore(kv, storage);
    store.save(makeSecrets());
    storageSetCorrupted(kv, storage, 'not json at all');
    expect(() => store.load()).toThrow(/secure_storage_unavailable/);
  });

  it('clear wipes every credential field', () => {
    const kv = new MemoryKv();
    const store = createSafeStorageSecretStore(kv, new FakeSafeStorage());
    store.save(makeSecrets());
    store.clear();
    expect(kv.map.size).toBe(0);
    expect(store.load()).toBeNull();
  });
});

describe('pairing flow', () => {
  it('exchanges the code, persists the credential, returns the scope', async () => {
    const kv = new MemoryKv();
    const store = createSafeStorageSecretStore(kv, new FakeSafeStorage());
    const pairResponse = makePairResponse({ server_signing_pubkey: makeB64Url32() });
    const transport = new FakeTransport({ pair: pairResponse });
    const identity = await pairDevice(
      { transport, secrets: store, agentVersion: '0.1.0' },
      { pairingCode: 'ABCD1234', deviceName: 'Cashier PC' },
    );
    expect(identity).toEqual({
      deviceId: pairResponse.device_id,
      tenantId: pairResponse.tenant_id,
      restaurantId: pairResponse.restaurant_id,
    });
    const loaded = store.load();
    expect(loaded?.deviceToken).toBe('device-token-abc');
    expect(loaded?.serverSigningPubkey).toBe(pairResponse.server_signing_pubkey);
    expect(loaded?.devicePrivateKey).not.toBe(''); // device keypair generated and stored
    const call = transport.callsOf('pair')[0];
    expect(call).toBeDefined();
  });

  it('maps request_rejected to a generate-a-new-code error without retrying', async () => {
    const transport = new FakeTransport({
      pair: new CloudError('request_rejected', 'status 410: pairing_code_expired'),
    });
    await expect(
      pairDevice(
        {
          transport,
          secrets: createSafeStorageSecretStore(new MemoryKv(), new FakeSafeStorage()),
          agentVersion: '0.1.0',
        },
        { pairingCode: 'EXPIRED1', deviceName: 'PC' },
      ),
    ).rejects.toThrow(/generate a new code/);
    expect(transport.callsOf('pair')).toHaveLength(1);
  });

  it('preserves the server machine code through the request_rejected rethrow', async () => {
    // mapPairFailure keys the `expired` reason off serverCode — dropping it
    // here would report every expired code as invalid_code.
    const transport = new FakeTransport({
      pair: new CloudError(
        'request_rejected',
        'status 410: pairing_code_expired',
        undefined,
        'pairing_code_expired',
      ),
    });
    await expect(
      pairDevice(
        {
          transport,
          secrets: createSafeStorageSecretStore(new MemoryKv(), new FakeSafeStorage()),
          agentVersion: '0.1.0',
        },
        { pairingCode: 'EXPIRED1', deviceName: 'PC' },
      ),
    ).rejects.toMatchObject({
      code: 'request_rejected',
      serverCode: 'pairing_code_expired',
    });
  });

  it('persists nothing (fail closed) when secure storage is unavailable', async () => {
    const kv = new MemoryKv();
    const storage = new FakeSafeStorage();
    storage.available = false;
    const transport = new FakeTransport({ pair: makePairResponse() });
    await expect(
      pairDevice(
        { transport, secrets: createSafeStorageSecretStore(kv, storage), agentVersion: '0.1.0' },
        { pairingCode: 'ABCD1234', deviceName: 'PC' },
      ),
    ).rejects.toThrow(/secure_storage_unavailable/);
    expect(kv.map.size).toBe(0);
  });

  it('network failures propagate untouched (transport decides retry policy)', async () => {
    const transport = new FakeTransport({ pair: new CloudError('network') });
    await expect(
      pairDevice(
        {
          transport,
          secrets: createSafeStorageSecretStore(new MemoryKv(), new FakeSafeStorage()),
          agentVersion: '0.1.0',
        },
        { pairingCode: 'ABCD1234', deviceName: 'PC' },
      ),
    ).rejects.toMatchObject({ code: 'network' });
  });
});

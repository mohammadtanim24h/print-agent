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

  it('treats any missing field as unpaired (atomic write set)', () => {
    const kv = new MemoryKv();
    const store = createSafeStorageSecretStore(kv, new FakeSafeStorage());
    store.save(makeSecrets());
    kv.delete('cloud.refreshToken');
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
    kv.set('cloud.deviceId', 'not-a-uuid');
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

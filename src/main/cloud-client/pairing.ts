import { generateDeviceKeyPair } from './envelope-sig';
import { CloudError } from './errors';
import type { AgentIdentity, AgentTransport } from './types';
import type { SecretStore } from './secret-store';

/**
 * Pairing flow (api-contract §3.4, ADR-7): the manager generates a short-TTL
 * single-use code in the SaaS dashboard; the agent exchanges it — together
 * with a freshly generated ed25519 device keypair — for a device credential.
 * The credential is persisted through the safeStorage-backed SecretStore; if
 * secure storage is unavailable the exchange result is discarded (fail closed).
 */
export interface PairingDeps {
  readonly transport: AgentTransport;
  readonly secrets: SecretStore;
  readonly agentVersion: string;
}

export async function pairDevice(
  deps: PairingDeps,
  request: { readonly pairingCode: string; readonly deviceName: string },
): Promise<AgentIdentity> {
  const keyPair = generateDeviceKeyPair();
  let response;
  try {
    response = await deps.transport.pair({
      pairing_code: request.pairingCode,
      device_pubkey: keyPair.publicKeyRaw,
      device_name: request.deviceName,
      agent_version: deps.agentVersion,
    });
  } catch (err) {
    if (err instanceof CloudError && err.code === 'request_rejected') {
      // Single-use code: expired / already used / unknown. Re-pairing requires
      // a fresh code from the dashboard; the agent must not retry blindly.
      // serverCode (e.g. pairing_code_expired) MUST survive the rethrow —
      // mapPairFailure keys the `expired` reason off it.
      throw new CloudError(
        'request_rejected',
        'pairing code rejected — generate a new code',
        undefined,
        err.serverCode,
      );
    }
    throw err;
  }

  const secrets = {
    deviceId: response.device_id,
    deviceToken: response.device_token,
    refreshToken: response.refresh_token,
    devicePrivateKey: keyPair.privateKeyPkcs8,
    devicePublicKey: keyPair.publicKeyRaw,
    serverSigningPubkey: response.server_signing_pubkey,
    tenantId: response.tenant_id,
    restaurantId: response.restaurant_id,
  };
  // Throws (and persists nothing) when safeStorage is unavailable.
  deps.secrets.save(secrets);
  return {
    deviceId: secrets.deviceId,
    tenantId: secrets.tenantId,
    restaurantId: secrets.restaurantId,
  };
}

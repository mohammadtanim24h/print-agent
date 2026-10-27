import { describe, expect, it } from 'vitest';
import { deriveWssUrl, assertWssUrl } from '../src/main/cloud-client/ws-channel';
import { CloudError } from '../src/main/cloud-client/errors';

describe('deriveWssUrl', () => {
  it('maps the REST base URL to the §1 WSS endpoint path', () => {
    expect(deriveWssUrl('https://saas.example.com/api/agent/v1')).toBe(
      'wss://saas.example.com/agent/v1/ws',
    );
  });

  it('preserves the port and strips query/hash', () => {
    expect(deriveWssUrl('https://saas.test:8443/api/agent/v1?x=1')).toBe(
      'wss://saas.test:8443/agent/v1/ws',
    );
  });

  it('maps http to ws (dev-only; production refusal is assertWssUrl’s job)', () => {
    expect(deriveWssUrl('http://localhost:8000/api/agent/v1')).toBe(
      'ws://localhost:8000/agent/v1/ws',
    );
  });
});

describe('assertWssUrl', () => {
  it('accepts wss://', () => {
    expect(assertWssUrl('wss://saas.test/agent/v1/ws', false)).toBe('wss://saas.test/agent/v1/ws');
  });

  it('refuses ws:// by default', () => {
    expect(() => assertWssUrl('ws://saas.test/agent/v1/ws', false)).toThrow(CloudError);
  });

  it('refuses garbage', () => {
    expect(() => assertWssUrl('not a url', false)).toThrow(CloudError);
  });

  it('allows ws:// outside production when explicitly opted in', () => {
    expect(assertWssUrl('ws://127.0.0.1:9876/agent/v1/ws', true)).toBe(
      'ws://127.0.0.1:9876/agent/v1/ws',
    );
  });
});

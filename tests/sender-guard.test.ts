import { describe, expect, it } from 'vitest';
import { createSenderGuard, IpcAccessError } from '../src/main/security/sender-guard';

const guard = createSenderGuard({
  allowedUrlPrefixes: ['file:///C:/app/out/renderer/', 'http://localhost:5173/'],
});

function frameEvent(url: string | undefined) {
  return { senderFrame: url === undefined ? null : { url } };
}

describe('sender guard', () => {
  it('allows frames whose URL is under an allowlisted prefix', () => {
    expect(() => {
      guard.assertTrusted(frameEvent('file:///C:/app/out/renderer/index.html'));
    }).not.toThrow();
    expect(() => {
      guard.assertTrusted(frameEvent('http://localhost:5173/src/main.tsx'));
    }).not.toThrow();
  });

  it('rejects remote and foreign origins', () => {
    expect(() => {
      guard.assertTrusted(frameEvent('https://pos.example.com/'));
    }).toThrow(IpcAccessError);
    expect(() => {
      guard.assertTrusted(frameEvent('http://192.168.1.50:8080/'));
    }).toThrow(IpcAccessError);
  });

  it('rejects file URLs outside the bundled renderer', () => {
    expect(() => {
      guard.assertTrusted(frameEvent('file:///C:/Windows/notepad.exe'));
    }).toThrow(IpcAccessError);
  });

  it('is case-insensitive on Windows file paths', () => {
    expect(() => {
      guard.assertTrusted(frameEvent('file:///c:/APP/out/RENDERER/index.html'));
    }).not.toThrow();
  });

  it('rejects frames without a URL (no senderFrame)', () => {
    expect(() => {
      guard.assertTrusted(frameEvent(undefined));
    }).toThrow(IpcAccessError);
    expect(() => {
      guard.assertTrusted({});
    }).toThrow(IpcAccessError);
  });

  it('ignores URL userinfo tricks', () => {
    expect(() => {
      guard.assertTrusted(frameEvent('http://localhost:5173@evil.example/'));
    }).toThrow(IpcAccessError);
  });

  it('reports denials via the injected sink', () => {
    const denied: string[] = [];
    const logging = createSenderGuard({
      allowedUrlPrefixes: ['file:///C:/app/out/renderer/'],
      log: (m) => denied.push(m),
    });
    try {
      logging.assertTrusted(frameEvent('https://evil.example/'));
      expect.unreachable();
    } catch {
      // expected
    }
    expect(denied).toHaveLength(1);
  });
});

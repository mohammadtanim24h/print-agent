import { describe, expect, it } from 'vitest';
import { resolve, sep } from 'node:path';
import {
  RENDERER_ORIGIN_PREFIX,
  RENDERER_SCHEME,
  rendererContentType,
  rendererSchemePrivileges,
  resolveRendererUrl,
} from '../src/main/security/renderer-protocol';

const root = resolve('out/renderer');

describe('resolveRendererUrl', () => {
  it('maps app://bundle URLs onto the renderer root', () => {
    expect(resolveRendererUrl(root, 'app://bundle/index.html')).toBe(
      resolve(root, 'index.html'),
    );
    expect(resolveRendererUrl(root, 'app://bundle/assets/index-abc123.js')).toBe(
      resolve(root, 'assets/index-abc123.js'),
    );
  });

  it('decodes percent-encoded path segments', () => {
    expect(resolveRendererUrl(root, 'app://bundle/assets/my%20file.js')).toBe(
      resolve(root, 'assets/my file.js'),
    );
  });

  it('rejects other hosts and schemes', () => {
    expect(resolveRendererUrl(root, 'app://evil/index.html')).toBeUndefined();
    // userinfo trick: "bundle@evil" means host "evil"
    expect(resolveRendererUrl(root, 'app://bundle@evil/index.html')).toBeUndefined();
    expect(resolveRendererUrl(root, 'https://bundle/index.html')).toBeUndefined();
  });

  it('rejects dot-segment traversal that survives URL parsing', () => {
    // The WHATWG parser collapses literal "../" and "%2e%2e" segments before
    // we see them; these encoded separators survive and must hit the guard.
    expect(resolveRendererUrl(root, 'app://bundle/a%2f..%2f..%2fsecret.txt')).toBeUndefined();
    // On Windows, %5c decodes to a path separator — same traversal shape.
    expect(resolveRendererUrl(root, 'app://bundle/assets%5c..%5c..%5cx')).toBeUndefined();
  });

  it('never resolves outside the renderer root (containment property)', () => {
    for (const url of [
      'app://bundle/../secret.txt', // URL parser normalizes this to /secret.txt
      'app://bundle/%2e%2e/secret.txt',
      'app://bundle/a%00b', // decoded NUL
      'app://bundle/%2e%e2%8e%a5/x',
    ]) {
      const result = resolveRendererUrl(root, url);
      if (result !== undefined) {
        expect(result.startsWith(root + sep) || result === root).toBe(true);
      }
    }
  });

  it('rejects empty paths, invalid URLs, and failed percent-decoding', () => {
    expect(resolveRendererUrl(root, 'app://bundle/')).toBeUndefined();
    expect(resolveRendererUrl(root, '')).toBeUndefined();
    expect(resolveRendererUrl(root, 'not a url')).toBeUndefined();
    expect(resolveRendererUrl(root, 'app://bundle/%zz')).toBeUndefined();
  });
});

describe('rendererContentType', () => {
  it('maps the shipped file types', () => {
    expect(rendererContentType('index.html')).toBe('text/html; charset=utf-8');
    expect(rendererContentType('assets/index.js')).toBe('text/javascript; charset=utf-8');
    expect(rendererContentType('assets/index.mjs')).toBe('text/javascript; charset=utf-8');
    expect(rendererContentType('assets/index.css')).toBe('text/css; charset=utf-8');
    expect(rendererContentType('assets/logo.svg')).toBe('image/svg+xml');
    expect(rendererContentType('assets/logo.png')).toBe('image/png');
    expect(rendererContentType('manifest.json')).toBe('application/json');
  });

  it('falls back to octet-stream for anything else', () => {
    expect(rendererContentType('assets/logo.wasm')).toBe('application/octet-stream');
    expect(rendererContentType('noextension')).toBe('application/octet-stream');
  });
});

describe('rendererSchemePrivileges', () => {
  it('registers the app scheme as standard/secure with fetch and code cache', () => {
    expect(rendererSchemePrivileges).toHaveLength(1);
    const entry = rendererSchemePrivileges[0];
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.scheme).toBe(RENDERER_SCHEME);
    expect(Object.keys(entry.privileges ?? {}).sort()).toEqual([
      'codeCache',
      'standard',
      'secure',
      'supportFetchAPI',
    ].sort());
    expect(entry.privileges).toEqual({
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
    });
  });

  it('grants no extra privileges beyond the four required', () => {
    const privileges = (rendererSchemePrivileges[0]?.privileges ?? {}) as Record<
      string,
      unknown
    >;
    expect(privileges['bypassCSP']).toBeUndefined();
    expect(privileges['corsEnabled']).toBeUndefined();
    expect(privileges['allowServiceWorkers']).toBeUndefined();
    expect(privileges['stream']).toBeUndefined();
  });

  it('exposes the served origin prefix', () => {
    expect(RENDERER_ORIGIN_PREFIX).toBe('app://bundle/');
  });
});

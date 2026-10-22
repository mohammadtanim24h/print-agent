import { describe, expect, it } from 'vitest';
import { installNoListenGuard, ListenForbiddenError } from '../src/main/security/no-listen-guard';

function fakeServerProto() {
  const calls: string[] = [];
  const listen = (...args: unknown[]) => {
    calls.push(JSON.stringify(args));
    return undefined as never;
  };
  return { proto: { listen }, calls };
}

describe('no-listen guard', () => {
  it('makes listen() throw a ListenForbiddenError', () => {
    const { proto } = fakeServerProto();
    const uninstall = installNoListenGuard(proto);
    expect(() => proto.listen(9100, '0.0.0.0')).toThrow(ListenForbiddenError);
    uninstall();
    expect(proto.listen(8080)).toBeUndefined();
  });

  it('uninstall restores the original listen exactly once', () => {
    const { proto } = fakeServerProto();
    const uninstall = installNoListenGuard(proto);
    uninstall();
    // after uninstall, calls go through to the original again
    expect(proto.listen(1234)).toBeUndefined();
    // uninstalling twice must not corrupt state
    expect(() => {
      uninstall();
    }).not.toThrow();
    expect(proto.listen(4321)).toBeUndefined();
  });

  it('error carries a stable machine code', () => {
    const err = new ListenForbiddenError();
    expect(err.code).toBe('LISTEN_FORBIDDEN');
  });
});

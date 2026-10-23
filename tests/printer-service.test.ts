import { describe, expect, it } from 'vitest';
import { createPrinterService } from '../src/main/printers/service';
import { createPrinterStore } from '../src/main/printers/store';
import { buildTestPage } from '../src/main/printers/test-page';
import { createTransportRegistry } from '../src/main/transport/registry';
import { mockSocketFactory, type MockSocket } from './helpers/mock-socket';
import { memoryAdapter } from './helpers/memory-adapter';
import { makeDraft } from './helpers/printers';

const NOW = new Date('2026-10-23T12:00:00.000Z');

async function setup(
  script: (socket: MockSocket) => void = (sock) => {
    sock.connect();
  },
) {
  const sockets = mockSocketFactory(script);
  const store = await createPrinterStore({
    filePath: 'printers.json',
    adapter: memoryAdapter(null),
    newId: () => '00000000-0000-4000-8000-0000000000aa',
  });
  const registry = createTransportRegistry({ socketFactory: sockets.factory });
  const service = createPrinterService({ store, registry, now: () => NOW });
  return { sockets, store, service };
}

describe('printer service', () => {
  it('saves a validated printer and returns it with an id', async () => {
    const { service } = await setup();
    const profile = await service.savePrinter(makeDraft());
    expect(profile.printerId).toBe('00000000-0000-4000-8000-0000000000aa');
    expect(profile.transport).toEqual({ kind: 'tcp_raw', host: '192.168.1.50', port: 9100 });
  });

  it('refuses disapproved destinations — the policy decides, not the caller', async () => {
    const { service } = await setup();
    await expect(
      service.savePrinter(
        makeDraft({ transport: { kind: 'tcp_raw', host: '10.0.0.1', port: 31337 } }),
      ),
    ).resolves.toBeDefined(); // private-LAN endpoints are the normal case
    await expect(
      service.savePrinter(
        makeDraft({ transport: { kind: 'tcp_raw', host: '127.0.0.1', port: 9100 } }),
      ),
    ).rejects.toThrow(); // loopback is rejected at the store boundary
  });

  it('runs a connection test against the stored endpoint', async () => {
    const { service, sockets } = await setup();
    const profile = await service.savePrinter(makeDraft());
    await expect(service.testConnection(profile.printerId)).resolves.toEqual({ ok: true });
    expect(sockets.last()?.destroyed).toBe(true);
  });

  it('classifies connection-test failures with a stable code', async () => {
    const { service } = await setup((sock) => {
      sock.refuse();
    });
    const profile = await service.savePrinter(makeDraft());
    const result = await service.testConnection(profile.printerId);
    expect(result).toMatchObject({ ok: false, code: 'connect_refused' });
  });

  it('throws for a connection test on an unknown printer', async () => {
    const { service } = await setup();
    await expect(service.testConnection('missing')).rejects.toThrow('printer not found');
  });

  it('test print writes the ESC/POS page through the transport', async () => {
    const { service, sockets } = await setup();
    const profile = await service.savePrinter(makeDraft());
    const result = await service.testPrint(profile.printerId);
    expect(result).toEqual({ ok: true, bytesWritten: buildTestPage(profile, NOW).byteLength });
    expect(sockets.last()?.written).toEqual([Buffer.from(buildTestPage(profile, NOW))]);
    expect(sockets.last()?.destroyed).toBe(true);
  });

  it('test print reports classified failures instead of throwing', async () => {
    const { service } = await setup((sock) => {
      sock.refuse();
    });
    const profile = await service.savePrinter(makeDraft());
    const result = await service.testPrint(profile.printerId);
    expect(result).toMatchObject({ ok: false, code: 'connect_refused' });
  });
});

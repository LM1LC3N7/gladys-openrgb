import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, normalizeMemory } from '../src/store.js';
import { normalizeConfig, parseAddress } from '../src/config.js';

test('the /data file: written atomically (0600), read back; not a plain file is refused', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'openrgb-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await store.save({ format: 1, address: '10.0.0.2:6742', devices: {}, guards: [] });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await store.load()).address, '10.0.0.2:6742');
  await writeFile(path, '{');
  await assert.rejects(store.load());
  await assert.rejects(fileStore(dir).load(), /not a plain file/);
});

test('the memory read back is repaired: bad ids, future dates, colors out of range dropped', () => {
  const now = Date.UTC(2026, 10, 11);
  const memory = normalizeMemory(
    {
      address: '10.0.0.2:6742',
      lastAttemptAt: now + 1000,
      devices: {
        '0123456789ab': { index: 3, color: 0x00ff00 },
        bad: { index: 1 },
        '0123456789ac': { index: -1, color: 0x1000000 },
      },
      guards: [{ id: '0123456789ab', resends: 2 }, { id: '0123456789ab' }, { id: '../x' }],
    },
    now,
  );
  assert.equal(memory.lastAttemptAt, undefined);
  assert.deepEqual(memory.devices, {
    '0123456789ab': { index: 3, color: 0x00ff00 },
    '0123456789ac': {},
  });
  assert.deepEqual(memory.guards, [{ id: '0123456789ab', resends: 2 }]);
  assert.equal(normalizeMemory({ address: 'http://x/y' }).address, undefined);
});

test('the address: port 6742 unless given; schemes, paths, broadcast and multicast refused', () => {
  assert.deepEqual(parseAddress('192.168.1.20'), { host: '192.168.1.20', port: 6742 });
  assert.deepEqual(parseAddress('PC-Salon.lan:6743'), { host: 'pc-salon.lan', port: 6743 });
  assert.deepEqual(parseAddress('[fe80::1]:6742'), { host: 'fe80::1', port: 6742 });
  for (const bad of [
    'http://1.2.3.4',
    '1.2.3.4/x',
    '255.255.255.255',
    '224.0.0.1',
    '0.0.0.0',
    '1.2.3.4:0',
    'a b',
    'x\r\ny',
  ]) {
    assert.equal(parseAddress(bad).error, 'invalid', bad);
  }
  const config = normalizeConfig({
    server: ' 10.0.0.2 ',
    poll_interval: '2',
    allow_modes: 'true',
    allow_profiles: 1,
  });
  assert.equal(config.address.key, '10.0.0.2:6742');
  assert.equal(config.pollInterval, 5);
  assert.equal(config.allowModes, true);
  assert.equal(config.allowProfiles, false);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 10);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, TIMINGS } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { encodePacket } from '../src/openrgb/protocol.js';
import { controller, fakeOpenRGB, mode } from './helpers/fakeOpenRGB.js';
import { F, PROFILE, SECOND, SERVER, START, created, idOf, setup } from './helpers/app.js';

const ID = idOf();
const sentLeds = (world, index) => world.sent(COMMANDS.UPDATE_LEDS, index);
const ledColor = (packet) => (packet.body[6] << 16) | (packet.body[7] << 8) | packet.body[8];

test('a read publishes light, color and mode of the created controllers; status connected', async () => {
  const t = await setup();
  await t.start();
  assert.equal(t.gladys.fake.lastState(F(ID, 'light')), 1);
  assert.equal(t.gladys.fake.lastState(F(ID, 'color')), 0xff0000);
  assert.equal(t.gladys.fake.lastState(F(ID, 'mode')), 'Direct');
  assert.equal(t.status().connected, true);
  assert.match(t.status().message.en, /1 controller/);
  // The client name is set, no write on any controller.
  assert.equal(t.world.sent(COMMANDS.SET_CLIENT_NAME).length, 1);
  assert.equal(sentLeds(t.world).length, 0);
  await t.app.shutdown();
});

test('a color: written in direct mode, confirmed by the read, remembered for "on"', async () => {
  const t = await setup();
  await t.start();
  const answer = await t.cmd(F(ID, 'color'), 0x00ff00);
  assert.equal(answer.success, true);
  assert.match(answer.data ?? answer.message ?? '', /lecture le montre|^$/);
  assert.deepEqual(t.world.controllers[0].colors, [0x00ff00, 0x00ff00, 0x00ff00, 0x00ff00]);
  assert.equal(t.gladys.fake.lastState(F(ID, 'color')), 0x00ff00);
  assert.equal(t.store.data.devices[ID].color, 0x00ff00);
  await t.cmd(F(ID, 'light'), 0);
  assert.equal(t.gladys.fake.lastState(F(ID, 'light')), 0);
  const before = sentLeds(t.world).length;
  await t.cmd(F(ID, 'light'), 1);
  const last = sentLeds(t.world).at(-1);
  assert.equal(sentLeds(t.world).length, before + 1);
  assert.equal(ledColor(last), 0x00ff00);
  assert.equal(t.gladys.fake.lastState(F(ID, 'light')), 1);
  // Already on: nothing written.
  await t.cmd(F(ID, 'light'), 1);
  assert.equal(sentLeds(t.world).length, before + 1);
  await t.app.shutdown();
});

test('values out of range are refused, nothing sent', async () => {
  const t = await setup();
  await t.start();
  for (const [key, value] of [
    ['light', 2],
    ['light', -1],
    ['color', 0x1000000],
    ['color', 1.5],
    ['mode', ''],
  ]) {
    const answer = await t.cmd(F(ID, key), value);
    assert.equal(answer.success, false, `${key} ${value}`);
  }
  assert.equal(sentLeds(t.world).length, 0);
  await t.app.shutdown();
});

test('a color the read does not show is "sent, without confirmation"', async () => {
  const world = fakeOpenRGB();
  world.applyLeds = false;
  const t = await setup({ world });
  await t.start();
  const answer = await t.cmd(F(ID, 'color'), 0x0000ff);
  assert.equal(answer.success, true);
  assert.match(JSON.stringify(answer), /sans confirmation/);
  await t.app.shutdown();
});

test('Off: black in direct mode, confirmed; not shown, kept and sent again 3 times at most', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world });
  await t.start();
  world.applyLeds = false;
  const answer = await t.cmd(F(ID, 'light'), 0);
  assert.equal(answer.success, true);
  assert.match(JSON.stringify(answer), /renvoyée aux prochaines lectures/);
  assert.deepEqual(
    t.store.data.guards.map((g) => [g.id, g.resends]),
    [[ID, 0]],
  );
  const sent = () => sentLeds(world).filter((p) => ledColor(p) === 0).length;
  assert.equal(sent(), 1);
  for (let i = 0; i < 5; i += 1) await t.wait(10 * SECOND);
  assert.equal(sent(), 4, 'sent again 3 times, then given up');
  assert.deepEqual(t.store.data.guards, []);
  await t.app.shutdown();
});

test('an Off kept is done when a read shows it; a newer color that left ends its resends', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world });
  await t.start();
  world.applyLeds = false;
  await t.cmd(F(ID, 'light'), 0);
  world.applyLeds = true;
  await t.cmd(F(ID, 'color'), 0x0000ff);
  assert.deepEqual(t.store.data.guards, []);
  const before = sentLeds(world).length;
  await t.wait(30 * SECOND);
  assert.equal(sentLeds(world).length, before, 'no Off sent again over the newer color');
  assert.deepEqual(world.controllers[0].colors[0], 0x0000ff);
  await t.app.shutdown();
});

test('Off from /data at start, without the configuration (getConfig fails)', async () => {
  const world = fakeOpenRGB();
  world.applyLeds = true;
  const store = memoryStore({
    format: 1,
    address: `${SERVER}:6742`,
    devices: { [ID]: { index: 0 } },
    guards: [{ id: ID, resends: 0, at: START - 60_000 }],
  });
  const t = await setup({
    world,
    store,
    getConfig: async () => {
      throw new Error('down');
    },
  });
  await t.start();
  assert.equal(world.controllers[0].colors[0], 0);
  assert.deepEqual(t.store.data.guards, []);
  assert.match(t.status().message.en, /configuration could not be read/);
  // A command from the user too, while the configuration is still not read.
  world.controllers[0].colors.fill(0x123456);
  const answer = await t.cmd(F(ID, 'light'), 0);
  assert.equal(answer.success, true);
  assert.equal(world.controllers[0].colors[0], 0);
  await t.app.shutdown();
});

test('getConfig failing in connected: tried again, spaced, then the reads start', async () => {
  let calls = 0;
  const t = await setup({
    getConfig: async () => {
      calls += 1;
      if (calls === 1) throw new Error('down');
      return { server: SERVER };
    },
  });
  await t.start();
  assert.equal(calls, 1);
  assert.equal(t.status().connected, false);
  await t.wait(6 * SECOND);
  assert.equal(calls, 2);
  assert.equal(t.status().connected, true);
  assert.equal(t.gladys.fake.lastState(F(ID, 'light')), 1);
  await t.app.shutdown();
});

test('an Off cancels the commands of the same controller still waiting', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world });
  await t.start();
  // The identity read again (the list changed): the color waits for it.
  world.push(encodePacket(COMMANDS.DEVICE_LIST_UPDATED, 0));
  world.latency = 400;
  const device = t.gladys.devices[0];
  const color = t.gladys.fake.setValue(device, { external_id: F(ID, 'color') }, 0x00ff00);
  await t.wait(10);
  const off = t.gladys.fake.setValue(device, { external_id: F(ID, 'light') }, 0);
  const [a, b] = await t.act(Promise.all([color, off]));
  assert.equal(b.success, true);
  assert.equal(a.success, false);
  assert.match(JSON.stringify(a), /extinction est arrivée après/);
  assert.equal(world.controllers[0].colors[0], 0);
  // Nothing of the color left after the Off.
  const leds = sentLeds(world);
  assert.equal(ledColor(leds.at(-1)), 0);
  assert.ok(leds.every((p) => ledColor(p) === 0));
  await t.app.shutdown();
});

test('an Off cuts a read stalled for 1 s, on a new connection after the old one closed', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world });
  await t.start();
  // The next read gets no answer.
  let stall = true;
  world.stallOn = (p) => stall && p.command === COMMANDS.REQUEST_CONTROLLER_COUNT;
  await t.wait(9 * SECOND + 100);
  stall = false;
  const before = world.connections;
  const answer = await t.cmd(F(ID, 'light'), 0);
  assert.equal(answer.success, true);
  assert.equal(world.controllers[0].colors[0], 0);
  assert.equal(world.connections, before + 1);
  assert.ok(world.open <= 1);
  // The cut read is not a failure of the server.
  assert.equal(t.app.failures, 0);
  await t.app.shutdown();
});

test('the identity is read before every write: a controller moved is written at its new index', async () => {
  const other = controller({
    name: 'Trident Z',
    vendor: 'G.Skill',
    location: 'I2C: /dev/i2c-1, address 0x58',
  });
  const world = fakeOpenRGB({ controllers: [controller(), other] });
  const t = await setup({ world, devices: [created(controller()), created(other)] });
  await t.start();
  // OpenRGB tells its clients when its list changes.
  world.controllers.reverse();
  world.push(encodePacket(COMMANDS.DEVICE_LIST_UPDATED, 0));
  await t.cmd(F(ID, 'color'), 0x0000ff);
  assert.equal(world.controllers[1].colors[0], 0x0000ff);
  assert.equal(world.controllers[0].colors[0], 0xff0000);
  assert.ok(sentLeds(world).every((p) => p.index === 1));
  // Moved without a notice: an identity read serves an interval plus 5 s at most.
  world.controllers.reverse();
  // (the periodic read would refresh it: aged by hand)
  t.app.verified.get(ID).at -= 15 * SECOND + 1;
  await t.cmd(F(ID, 'color'), 0x00ffff);
  assert.equal(world.controllers[0].colors[0], 0x00ffff);
  world.controllers.reverse();
  // Gone from the server: nothing sent.
  world.push(encodePacket(COMMANDS.DEVICE_LIST_UPDATED, 0));
  world.controllers.splice(1, 1);
  const before = sentLeds(world).length;
  const answer = await t.cmd(F(ID, 'color'), 0x00ff00);
  assert.equal(answer.success, false);
  assert.match(JSON.stringify(answer), /plus sur le serveur/);
  assert.equal(sentLeds(world).length, before);
  await t.app.shutdown();
});

test('two controllers alike without a serial are both left out', async () => {
  const world = fakeOpenRGB({ controllers: [controller(), controller()] });
  // Even with an index remembered in /data from before the second one came.
  const store = memoryStore({ format: 1, devices: { [ID]: { index: 0 } }, guards: [] });
  const t = await setup({ world, store, devices: [created()] });
  await t.start();
  assert.equal(t.gladys.fake.lastState(F(ID, 'light')), undefined);
  assert.match(t.status().message.en, /2 controller\(s\) left out/);
  const answer = await t.cmd(F(ID, 'light'), 0);
  assert.equal(answer.success, false);
  assert.equal(sentLeds(world).length, 0);
  await t.app.shutdown();
});

test('modes: refused while the option is off (checked again before sending), applied when on', async () => {
  const t = await setup();
  await t.start();
  let answer = await t.cmd(F(ID, 'mode'), 'Rainbow Wave');
  assert.equal(answer.success, false);
  assert.match(JSON.stringify(answer), /mode est désactivé/);
  assert.equal(t.world.sent(COMMANDS.UPDATE_MODE).length, 0);
  await t.act(t.gladys.fake.configUpdated({ server: SERVER, allow_modes: true }));
  answer = await t.cmd(F(ID, 'mode'), 'Rainbow Wave');
  assert.equal(answer.success, true);
  assert.equal(t.world.controllers[0].activeMode, 2);
  assert.equal(t.gladys.fake.lastState(F(ID, 'mode')), 'Rainbow Wave');
  answer = await t.cmd(F(ID, 'mode'), 'Nope');
  assert.equal(answer.success, false);
  // The option unticked while the command waits (identity read): nothing leaves.
  t.world.latency = 300;
  t.world.push(encodePacket(COMMANDS.DEVICE_LIST_UPDATED, 0));
  const pending = t.gladys.fake.setValue(
    t.gladys.devices[0],
    { external_id: F(ID, 'mode') },
    'Static',
  );
  await t.wait(10);
  t.app.config.allowModes = false;
  answer = await t.act(pending);
  assert.equal(answer.success, false);
  assert.equal(t.world.sent(COMMANDS.UPDATE_MODE).length, 1);
  await t.app.shutdown();
});

test('profiles: refused while off; a listed one is loaded and ends the Off resends', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world });
  await t.start();
  let answer = await t.cmd(PROFILE, 'Night');
  assert.equal(answer.success, false);
  assert.match(JSON.stringify(answer), /profil est désactivé/);
  await t.act(t.gladys.fake.configUpdated({ server: SERVER, allow_profiles: true }));
  answer = await t.cmd(PROFILE, 'Unknown');
  assert.equal(answer.success, false);
  assert.equal(world.loaded, undefined);
  world.applyLeds = false;
  await t.cmd(F(ID, 'light'), 0);
  answer = await t.cmd(PROFILE, 'Night');
  assert.equal(answer.success, true);
  assert.equal(world.loaded, 'Night');
  assert.deepEqual(t.store.data.guards, []);
  await t.app.shutdown();
});

test('never a read sooner than the interval: restart, same configuration, button', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world, config: { server: SERVER, poll_interval: 30 } });
  await t.start();
  const reads = () => world.sent(COMMANDS.REQUEST_CONTROLLER_COUNT).length;
  assert.equal(reads(), 1);
  await t.act(t.gladys.fake.configUpdated({ server: SERVER, poll_interval: 30 }));
  await t.act(t.gladys.fake.send('integration.action', { key: 'test_connection' }).catch(() => {}));
  await t.act(t.app.testConnection());
  await t.app.onConnected(async () => ({ server: SERVER, poll_interval: 30 }));
  await t.wait(1000);
  assert.equal(reads(), 1);
  await t.wait(29 * SECOND);
  assert.equal(reads(), 2);
  await t.app.shutdown();
});

test('a restart never reads sooner than the interval after the last attempt (/data)', async () => {
  const world = fakeOpenRGB();
  const store = memoryStore({
    format: 1,
    lastAttemptAt: START - 4 * SECOND,
    devices: {},
    guards: [],
  });
  const t = await setup({ world, store });
  await t.start();
  const reads = () => world.sent(COMMANDS.REQUEST_CONTROLLER_COUNT).length;
  assert.equal(reads(), 0);
  assert.equal(t.gladys.fake.lastState(F(ID, 'light')), undefined, 'nothing old published');
  // Neither the button nor Discovery reads sooner.
  assert.match(await t.act(t.app.testConnection()), /prochaine lecture vient à son heure/);
  await t.act(t.gladys.fake.scanRequest());
  assert.equal(reads(), 0);
  await t.wait(4 * SECOND);
  assert.equal(reads(), 0, 'not before 10 s after the last attempt');
  await t.wait(1500);
  assert.equal(reads(), 1);
  // The attempt is in /data before the read.
  assert.ok(store.data.lastAttemptAt >= START + 5 * SECOND);
  await t.app.shutdown();
});

test('too many commands at once: the next one is refused, an Off still goes', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world });
  await t.start();
  world.latency = 500;
  const device = t.gladys.devices[0];
  const pending = Array.from({ length: 32 }, (_, i) =>
    t.gladys.fake.setValue(device, { external_id: F(ID, 'color') }, 0x000100 + i),
  );
  await t.wait(10);
  const refused = await t.act(
    t.gladys.fake.setValue(device, { external_id: F(ID, 'color') }, 0x0000ff),
  );
  assert.equal(refused.success, false);
  assert.match(JSON.stringify(refused), /trop de commandes/);
  const off = await t.act(t.gladys.fake.setValue(device, { external_id: F(ID, 'light') }, 0));
  assert.equal(off.success, true);
  await t.act(Promise.all(pending));
  assert.equal(world.controllers[0].colors[0], 0);
  await t.app.shutdown();
});

test('a read period measured from the start of the reads, failures spaced', async () => {
  const world = fakeOpenRGB();
  world.latency = 200;
  const t = await setup({ world });
  await t.start();
  const reads = () => world.sent(COMMANDS.REQUEST_CONTROLLER_COUNT).length;
  const first = reads();
  await t.wait(60 * SECOND);
  assert.equal(reads() - first, 6);
  world.refuse = true;
  for (const socket of [...world.sockets]) socket.destroy();
  await t.wait(70 * SECOND);
  assert.equal(t.status().connected, false);
  assert.match(t.status().message.en, /does not answer/);
  // 10 s, then 20 s, then 40 s: 3 tries in 70 s.
  assert.ok(world.refused <= 4, `${world.refused} tries`);
  world.refuse = false;
  await t.wait(200 * SECOND);
  assert.equal(t.status().connected, true);
  await t.app.shutdown();
});

test('an answer over the size limit or not OpenRGB closes the connection: status, nothing published', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world, devices: [] });
  world.stallOn = (p) => p.command === COMMANDS.REQUEST_CONTROLLER_COUNT;
  await t.start();
  const big = encodePacket(COMMANDS.REQUEST_CONTROLLER_COUNT, 0);
  big.writeUInt32LE(2 * 1024 * 1024, 12);
  world.stallOn = (p) => {
    if (p.command === COMMANDS.REQUEST_CONTROLLER_COUNT) {
      t.clock.timers.setTimeout(() => world.push(big), 5);
      return true;
    }
    return false;
  };
  await t.wait(10 * SECOND);
  assert.match(t.status().message.en, /not as an OpenRGB SDK server/);
  assert.equal(world.open, 0);
  await t.app.shutdown();
});

test('packets nobody asked for are dropped; a device list update is not an answer', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world });
  await t.start();
  world.push(encodePacket(COMMANDS.DEVICE_LIST_UPDATED, 0));
  world.push(encodePacket(COMMANDS.REQUEST_CONTROLLER_COUNT, 0, Buffer.from([9, 0, 0, 0])));
  await t.wait(10 * SECOND);
  assert.equal(t.status().connected, true);
  assert.match(t.status().message.en, /1 controller/);
  await t.app.shutdown();
});

test('a scene on 5 slow controllers sets all 5; one gone does not stop the others', async () => {
  const controllers = Array.from({ length: 6 }, (_, i) =>
    controller({ name: `Strip ${i}`, location: `HID: ${i}` }),
  );
  const world = fakeOpenRGB({ controllers: [...controllers] });
  const t = await setup({ world, devices: controllers.map((c) => created(c)) });
  await t.start();
  world.latency = 120;
  world.push(encodePacket(COMMANDS.DEVICE_LIST_UPDATED, 0));
  world.controllers.splice(5, 1);
  const devices = t.gladys.devices;
  const answers = await t.act(
    Promise.all(
      controllers.map((c, i) =>
        t.gladys.fake.setValue(devices[i], { external_id: F(idOf(c), 'color') }, 0x0000ff),
      ),
    ),
  );
  assert.deepEqual(
    answers.map((a) => a.success),
    [true, true, true, true, true, false],
  );
  for (let i = 0; i < 5; i += 1) assert.equal(world.controllers[i].colors[0], 0x0000ff);
  await t.app.shutdown();
});

test('/data unreadable: never overwritten, read again; a failed save never blocks an Off', async () => {
  const store = memoryStore({
    format: 1,
    devices: { [ID]: { index: 0, color: 0x00ff00 } },
    guards: [],
  });
  store.unreadable = true;
  const t = await setup({ store });
  await t.start();
  await t.cmd(F(ID, 'color'), 0x0000ff);
  assert.equal(store.saves, 0);
  assert.equal(await t.app.saveNow(), false);
  assert.equal(store.saves, 0);
  // Saved unchanged: no read sooner (no time of attempt to go by).
  const reads = t.world.sent(COMMANDS.REQUEST_CONTROLLER_COUNT).length;
  await t.act(t.gladys.fake.configUpdated(t.gladys.config));
  await t.wait(1000);
  assert.equal(t.world.sent(COMMANDS.REQUEST_CONTROLLER_COUNT).length, reads);
  store.unreadable = false;
  await t.wait(TIMINGS.storeRetry + 1000);
  assert.ok(t.app.memory, 'read again');
  assert.equal(store.data.devices[ID].index, 0);
  store.fail = true;
  const answer = await t.cmd(F(ID, 'light'), 0);
  assert.equal(answer.success, true);
  assert.equal(t.world.controllers[0].colors[0], 0);
  await t.app.shutdown();
});

test('Discovery: the controllers of the last read and the profiles; created features kept', async () => {
  const world = fakeOpenRGB({
    controllers: [controller({ modes: [...controller().modes, mode('Breathing', { flags: 1 })] })],
  });
  const device = created();
  device.name = 'Mon PC';
  const t = await setup({ world, devices: [device] });
  await t.start();
  const reads = world.sent(COMMANDS.REQUEST_CONTROLLER_COUNT).length;
  await t.act(t.gladys.fake.scanRequest());
  assert.equal(world.sent(COMMANDS.REQUEST_CONTROLLER_COUNT).length, reads, 'no read sooner');
  const [found, server] = t.gladys.fake.discoveredDevices;
  assert.equal(found.name, 'Mon PC');
  const modeFeature = found.features.find((f) => f.external_id === F(ID, 'mode'));
  assert.deepEqual(
    modeFeature.supported_options.map((o) => o.value),
    ['Direct', 'Static', 'Rainbow Wave', 'Breathing'],
  );
  assert.deepEqual(
    server.features[0].supported_options.map((o) => o.label),
    ['Day', 'Night'],
  );
  assert.ok(found.features.every((f) => f.category !== 'switch'));
  await t.app.shutdown();
});

test('stopped: no timer left, no connection', async () => {
  const t = await setup();
  await t.start();
  await t.app.shutdown();
  await t.wait(1000);
  assert.equal(t.world.open, 0);
  const reads = t.world.sent(COMMANDS.REQUEST_CONTROLLER_COUNT).length;
  await t.wait(60 * SECOND);
  assert.equal(t.world.sent(COMMANDS.REQUEST_CONTROLLER_COUNT).length, reads);
});

test('no address, a wrong one: a clear status, no connection', async () => {
  const t = await setup({ config: {} });
  await t.start();
  assert.match(t.status().message.en, /Type the address/);
  await t.act(t.gladys.fake.configUpdated({ server: 'http://x/y' }));
  assert.match(t.status().message.en, /not valid/);
  assert.equal(t.world.connections, 0);
  await t.app.shutdown();
});

test('an Off kept ends when a later read shows it off: no resend', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world });
  await t.start();
  world.applyLeds = false;
  await t.cmd(F(ID, 'light'), 0);
  const offs = sentLeds(world).length;
  // Applied late (outside the integration).
  world.controllers[0].colors.fill(0);
  await t.wait(10 * SECOND);
  assert.deepEqual(t.store.data.guards, []);
  await t.wait(30 * SECOND);
  assert.equal(sentLeds(world).length, offs);
  await t.app.shutdown();
});

test('a command answers within the budget when the server stops answering', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world });
  await t.start();
  // Not read since the list changed: the command has to read first.
  world.push(encodePacket(COMMANDS.DEVICE_LIST_UPDATED, 0));
  world.silent = true;
  const started = t.clock.monotonic();
  const answer = await t.cmd(F(ID, 'color'), 0x0000ff);
  assert.equal(answer.success, false);
  assert.ok(t.clock.monotonic() - started <= 3500, `${t.clock.monotonic() - started} ms`);
  assert.equal(sentLeds(world).length, 0);
  await t.app.shutdown();
});

test('at most 250 states a minute, all readings counted', async () => {
  const controllers = Array.from({ length: 40 }, (_, i) =>
    controller({ name: `Strip ${i}`, location: `HID: ${i}` }),
  );
  const world = fakeOpenRGB({ controllers: [...controllers] });
  const t = await setup({
    world,
    devices: controllers.map((c) => created(c)),
    config: { server: SERVER, poll_interval: 5 },
  });
  await t.start();
  let n = 0;
  for (let s = 0; s < 120; s += 5) {
    n += 1;
    for (const c of world.controllers) c.colors.fill(0x010000 * ((n % 200) + 1));
    await t.wait(5 * SECOND);
  }
  const total = t.app.published.length;
  assert.ok(total <= 250 && total >= 200, `${total} states in the last minute`);
  await t.app.shutdown();
});

test('a new connection to Gladys forgets the published values: the next read sends them again', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world });
  await t.start();
  const count = () =>
    t.gladys.fake.states.filter((s) => s.device_feature_external_id === F(ID, 'light')).length;
  assert.equal(count(), 1);
  await t.app.onConnected(async () => ({ server: SERVER }));
  assert.equal(count(), 1, 'nothing published at the connection');
  await t.wait(10 * SECOND);
  assert.equal(count(), 2);
  await t.app.shutdown();
});

test('an Off goes before the commands waiting; a queued command of its controller is answered at once', async () => {
  const controllers = Array.from({ length: 6 }, (_, i) =>
    controller({ name: `Strip ${i}`, location: `HID: ${i}` }),
  );
  const world = fakeOpenRGB({ controllers: [...controllers] });
  const t = await setup({ world, devices: controllers.map((c) => created(c)) });
  await t.start();
  // The list changed: every command and the Off read the identity first.
  world.push(encodePacket(COMMANDS.DEVICE_LIST_UPDATED, 0));
  world.latency = 200;
  // The connection is held for the Off while its requests leave.
  const held = [];
  world.stallOn = (p) => {
    if (p.index === 5) held.push([p.command, t.app.link.holds]);
    return false;
  };
  const id = idOf(controllers[5]);
  const device = t.gladys.devices[5];
  const at = {};
  // Five colors for the other controllers, then one for ours: all queued.
  const others = [0, 1, 2, 3, 4].map((i) =>
    t.gladys.fake.setValue(
      t.gladys.devices[i],
      { external_id: F(idOf(controllers[i]), 'color') },
      0x0000ff,
    ),
  );
  const color = t.gladys.fake
    .setValue(device, { external_id: F(id, 'color') }, 0x00ff00)
    .then((a) => {
      at.color = t.clock.monotonic();
      return a;
    });
  await t.wait(100);
  const started = t.clock.monotonic();
  const off = t.gladys.fake.setValue(device, { external_id: F(id, 'light') }, 0).then((a) => {
    at.off = t.clock.monotonic();
    return a;
  });
  const [a, b] = await t.act(Promise.all([color, off, ...others]));
  assert.equal(a.success, false);
  assert.equal(b.success, true);
  assert.match(JSON.stringify(b), /lecture le montre/);
  assert.ok(
    at.color - started < 50,
    `the queued color answered ${at.color - started} ms after the Off`,
  );
  // Ahead of the 5 colors: the request in flight, then its own (count, data, writes, read).
  assert.ok(at.off - started < 1500, `${at.off - started} ms`);
  assert.equal(world.controllers[5].colors[0], 0);
  assert.deepEqual(held.slice(-4, -1), [
    [COMMANDS.REQUEST_CONTROLLER_DATA, 1],
    [COMMANDS.SET_CUSTOM_MODE, 1],
    [COMMANDS.UPDATE_LEDS, 1],
  ]);
  // Nothing else between the requests of the Off: count, identity, direct mode, LEDs.
  const end = world.log.findIndex(
    (p) => p.command === COMMANDS.UPDATE_LEDS && p.index === 5 && ledColor(p) === 0,
  );
  assert.deepEqual(
    world.log.slice(end - 3, end + 1).map((p) => [p.command, p.index]),
    [
      [COMMANDS.REQUEST_CONTROLLER_COUNT, 0],
      [COMMANDS.REQUEST_CONTROLLER_DATA, 5],
      [COMMANDS.SET_CUSTOM_MODE, 5],
      [COMMANDS.UPDATE_LEDS, 5],
    ],
  );
  await t.app.shutdown();
});

test('a stray answer during a request is not taken for it', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world });
  await t.start();
  world.latency = 300;
  world.stallOn = (p) => {
    if (p.command === COMMANDS.REQUEST_CONTROLLER_DATA) {
      t.clock.timers.setTimeout(
        () =>
          world.push(encodePacket(COMMANDS.REQUEST_CONTROLLER_COUNT, 0, Buffer.from([1, 0, 0, 0]))),
        10,
      );
    }
    return false;
  };
  await t.wait(10 * SECOND);
  assert.equal(t.status().connected, true);
  assert.equal(t.app.failures, 0);
  await t.app.shutdown();
});

test('slow answers: the command still answers within its budget', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world });
  await t.start();
  world.push(encodePacket(COMMANDS.DEVICE_LIST_UPDATED, 0));
  world.latency = 1400;
  const started = t.clock.monotonic();
  const answer = await t.cmd(F(ID, 'color'), 0x0000ff);
  assert.ok(t.clock.monotonic() - started <= 3500, `${t.clock.monotonic() - started} ms`);
  assert.match(JSON.stringify(answer), /sans confirmation|Rien envoyé/);
  await t.app.shutdown();
});

test('more controllers than the limit: refused as not OpenRGB, nothing published', async () => {
  const controllers = Array.from({ length: 65 }, (_, i) => controller({ location: `HID: ${i}` }));
  const world = fakeOpenRGB({ controllers });
  const t = await setup({ world, devices: [] });
  await t.start();
  assert.equal(t.status().connected, false);
  assert.match(t.status().message.en, /not as an OpenRGB SDK server/);
  await t.app.shutdown();
});

test('profiles: the option is checked again just before the load leaves', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world, config: { server: SERVER, allow_profiles: true } });
  await t.start();
  world.latency = 300;
  const pending = t.gladys.fake.setValue(t.gladys.devices[0], { external_id: PROFILE }, 'Night');
  await t.wait(10);
  t.app.config.allowProfiles = false;
  const answer = await t.act(pending);
  assert.equal(answer.success, false);
  assert.equal(world.loaded, undefined);
  assert.equal(world.sent(COMMANDS.LOAD_PROFILE).length, 0);
  await t.app.shutdown();
});

test('an Off after a profile asked: the profile never leaves after it, the Off stays kept', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world, config: { server: SERVER, allow_profiles: true } });
  await t.start();
  world.latency = 300;
  world.applyLeds = false;
  const device = t.gladys.devices[0];
  const profile = t.gladys.fake.setValue(device, { external_id: PROFILE }, 'Night');
  await t.wait(100);
  const off = t.gladys.fake.setValue(device, { external_id: F(ID, 'light') }, 0);
  const [a, b] = await t.act(Promise.all([profile, off]));
  assert.equal(a.success, false);
  assert.match(JSON.stringify(a), /extinction est arrivée après/);
  assert.equal(b.success, true);
  assert.equal(world.sent(COMMANDS.LOAD_PROFILE).length, 0);
  assert.deepEqual(
    t.store.data.guards.map((g) => g.id),
    [ID],
  );
  // A profile asked after the Off loads and ends its resends.
  const again = await t.cmd(PROFILE, 'Night');
  assert.equal(again.success, true);
  assert.deepEqual(t.store.data.guards, []);
  await t.app.shutdown();
});

for (const latency of [300, 500, 900]) {
  test(`a scene of 5 colors with answers in ${latency} ms: all 5 set; 5 Offs too`, async () => {
    const controllers = Array.from({ length: 5 }, (_, i) =>
      controller({ name: `Strip ${i}`, location: `HID: ${i}` }),
    );
    const world = fakeOpenRGB({ controllers: [...controllers] });
    const t = await setup({ world, devices: controllers.map((c) => created(c)) });
    await t.start();
    world.latency = latency;
    // Between two periodic reads, as late as possible.
    await t.wait(9 * SECOND);
    const scene = (feature, value) =>
      t.act(
        Promise.all(
          controllers.map((c, i) =>
            t.gladys.fake.setValue(
              t.gladys.devices[i],
              { external_id: F(idOf(c), feature) },
              value,
            ),
          ),
        ),
      );
    let answers = await scene('color', 0x0000ff);
    assert.deepEqual(
      answers.map((a) => a.success),
      [true, true, true, true, true],
    );
    for (const c of world.controllers) assert.equal(c.colors[0], 0x0000ff);
    const started = t.clock.monotonic();
    answers = await scene('light', 0);
    assert.ok(t.clock.monotonic() - started <= 3500);
    assert.ok(answers.every((a) => a.success));
    // Every Off left before its ack.
    for (const c of world.controllers) assert.equal(c.colors[0], 0);
    await t.app.shutdown();
  });
}

test('a scene right after the list changed (300 ms answers): the commands one after the other, never 0 set', async () => {
  const controllers = Array.from({ length: 5 }, (_, i) =>
    controller({ name: `Strip ${i}`, location: `HID: ${i}` }),
  );
  const world = fakeOpenRGB({ controllers: [...controllers] });
  const t = await setup({ world, devices: controllers.map((c) => created(c)) });
  await t.start();
  world.latency = 300;
  world.push(encodePacket(COMMANDS.DEVICE_LIST_UPDATED, 0));
  const answers = await t.act(
    Promise.all(
      controllers.map((c, i) =>
        t.gladys.fake.setValue(t.gladys.devices[i], { external_id: F(idOf(c), 'color') }, 0x0000ff),
      ),
    ),
  );
  // Each reads its identity (count, controller: 0.6 s) then writes, one after the other:
  // the first ones are set within the budget (interleaved, none would be).
  const set = world.controllers.filter((c) => c.colors[0] === 0x0000ff).length;
  assert.ok(set >= 3, `${set} set`);
  assert.equal(answers.filter((a) => a.success).length, set);
  await t.app.shutdown();
});

test('an Off drops at once the queued request of a command already in its turn', async () => {
  const world = fakeOpenRGB();
  const t = await setup({ world });
  await t.start();
  world.latency = 300;
  world.push(encodePacket(COMMANDS.DEVICE_LIST_UPDATED, 0));
  // The periodic read starts at 10 s; the color's identity read queues behind it.
  await t.wait(9 * SECOND + 50);
  const device = t.gladys.devices[0];
  const at = {};
  const color = t.gladys.fake
    .setValue(device, { external_id: F(ID, 'color') }, 0x00ff00)
    .then((a) => {
      at.color = t.clock.monotonic();
      return a;
    });
  await t.wait(50);
  const started = t.clock.monotonic();
  const off = t.gladys.fake.setValue(device, { external_id: F(ID, 'light') }, 0);
  const [a, b] = await t.act(Promise.all([color, off]));
  assert.equal(a.success, false);
  assert.equal(b.success, true);
  assert.ok(at.color - started < 50, `${at.color - started} ms`);
  await t.app.shutdown();
});

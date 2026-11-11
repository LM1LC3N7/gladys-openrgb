// -----------------------------------------------------------------------------
// The real clock (sped up) and real TCP (a fake OpenRGB server of the test kit
// on 127.0.0.1): the period of the reads as measured, an Off end to end, an
// oversized answer cut before its body is read. Every server, app and clock is
// closed in t.after, so a failing test never leaves a process behind.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { measurePeriod, realClock, spyOn, tcpServer } from './kit/index.mjs';
import { App } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { COMMANDS } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { encodePacket } from '../src/openrgb/protocol.js';
import { fakeOpenRGB } from './helpers/fakeOpenRGB.js';
import { F, SELECTOR, created, idOf } from './helpers/app.js';

const ID = idOf();

async function boot(t, { speed = 20, onData } = {}) {
  const world = fakeOpenRGB();
  const conns = new Map();
  const server = await tcpServer({
    onData:
      onData ??
      ((chunk, conn) => {
        if (!conns.has(conn.id)) conns.set(conn.id, { buffer: Buffer.alloc(0), version: 0 });
        const answers = world.feed(conns.get(conn.id), chunk);
        return answers.length ? Buffer.concat(answers) : undefined;
      }),
  });
  const clock = realClock({ speed });
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { server: `127.0.0.1:${server.port}`, poll_interval: 10 },
    devices: [created()],
  });
  await gladys.connect();
  const app = new App({
    gladys,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  registerHandlers(gladys, app, { error() {} });
  t.after(async () => {
    await app.shutdown();
    clock.close();
    await server.close();
  });
  return { world, server, clock, gladys, app };
}

const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('real clock: the reads every interval (10 s), measured', async (t) => {
  const { app, clock } = await boot(t);
  const spy = spyOn(app, 'poll', clock);
  t.after(() => spy.restore());
  await app.onConnected(async () => app.gladys.getConfig());
  await measurePeriod(spy, { count: 4, period: 10_000, timeoutMs: 20_000 });
});

test('real TCP: an Off leaves on the wire, the read shows it', async (t) => {
  const { app, gladys, world } = await boot(t);
  await app.onConnected(async () => gladys.getConfig());
  await until(() => gladys.fake.lastState(F(ID, 'light')) === 1);
  const answer = await gladys.fake.setValue(gladys.devices[0], { external_id: F(ID, 'light') }, 0);
  assert.equal(answer.success, true, JSON.stringify(answer));
  assert.equal(world.controllers[0].colors[0], 0);
  assert.equal(gladys.fake.lastState(F(ID, 'light')), 0);
});

test('real TCP: a packet announced over the limit closes the connection before its body', async (t) => {
  const big = encodePacket(COMMANDS.REQUEST_PROTOCOL_VERSION, 0);
  big.writeUInt32LE(64 * 1024 * 1024, 12);
  const { app, gladys, server } = await boot(t, { onData: () => big });
  await app.onConnected(async () => gladys.getConfig());
  await until(() => gladys.fake.connectionStatus?.connected === false);
  assert.match(gladys.fake.connectionStatus.message.en, /not as an OpenRGB SDK server/);
  await until(() => server.open === 0);
});

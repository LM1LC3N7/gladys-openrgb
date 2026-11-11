import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS } from '../src/constants.js';
import { Link, PRIORITY } from '../src/openrgb/client.js';
import * as P from '../src/openrgb/protocol.js';
import { testClock } from './kit/index.mjs';
import { fakeOpenRGB } from './helpers/fakeOpenRGB.js';
import { settle } from './helpers/app.js';

test('a held connection lets only the Offs leave until released', async () => {
  const world = fakeOpenRGB();
  const clock = testClock({ start: 0 });
  world.clock = clock;
  const link = new Link({ host: 'x', port: 1, transport: world.transport, ...clock });
  const step = async () => {
    for (let i = 0; i < 20; i += 1) {
      await clock.advance(10);
      await settle(3);
    }
  };
  const count = () => world.sent(COMMANDS.REQUEST_CONTROLLER_COUNT).length;
  const release = link.reserve();
  const read = link.request(P.requestControllerCount(), {
    expect: COMMANDS.REQUEST_CONTROLLER_COUNT,
  });
  await step();
  assert.equal(count(), 0);
  const off = link.request(P.requestControllerCount(), {
    expect: COMMANDS.REQUEST_CONTROLLER_COUNT,
    priority: PRIORITY.OFF,
  });
  await step();
  assert.equal(count(), 1);
  await off;
  release();
  await step();
  assert.equal(count(), 2);
  await read;
  link.close();
});

test('queued jobs leave by priority: an Off, then a command, then a read', async () => {
  const world = fakeOpenRGB();
  const clock = testClock({ start: 0 });
  world.clock = clock;
  world.latency = 100;
  const link = new Link({ host: 'x', port: 1, transport: world.transport, ...clock });
  const order = [];
  const ask = (priority, name) =>
    link
      .request(P.requestControllerCount(), { expect: COMMANDS.REQUEST_CONTROLLER_COUNT, priority })
      .then(() => order.push(name));
  const all = Promise.all([
    ask(PRIORITY.READ, 'first'),
    ask(PRIORITY.READ, 'read'),
    ask(PRIORITY.COMMAND, 'command'),
    ask(PRIORITY.OFF, 'off'),
  ]);
  for (let i = 0; i < 200; i += 1) {
    await clock.advance(10);
    await settle(3);
  }
  await all;
  // All queued while the connection opens: by priority, then in order.
  assert.deepEqual(order, ['off', 'command', 'first', 'read']);
  link.close();
});

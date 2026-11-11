// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a fake OpenRGB server and the virtual
// clock of the shared test kit: every read of `now()` or `monotonic()` moves
// the time by 1 µs, so a decision reading the clock twice is caught.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { testClock } from '../kit/index.mjs';
import { App } from '../../src/app.js';
import { buildDevice, controllerId } from '../../src/model.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { parseController } from '../../src/openrgb/protocol.js';
import { controller, encodeController, fakeOpenRGB } from './fakeOpenRGB.js';

export const SELECTOR = 'openrgb';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const START = Date.UTC(2026, 10, 11, 12, 0, 0);
export const SERVER = '192.168.1.20';
export const CONFIG = { server: SERVER };

/** The parsed form of a fake controller (what the app reads). */
export const parsed = (c = controller()) => parseController(encodeController(c, 5), 5);
export const idOf = (c = controller()) => controllerId(parsed(c));

/** The external id of a feature: `F(id, 'light')`. */
export const F = (id, key) => `ext:${SELECTOR}:controller:${id}${key ? `:${key}` : ''}`;
export const PROFILE = `ext:${SELECTOR}:server:openrgb:profile`;

/** A device as the user created it from the Discovery list. */
export function created(c = controller()) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  return buildDevice(gladys, parsed(c), { id: idOf(c), language: 'fr', address: `${SERVER}:6742` });
}

export const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

export async function setup({
  config = CONFIG,
  world = fakeOpenRGB(),
  devices = world.controllers.map((c) => created(c)),
  store = memoryStore(),
  clock = testClock({ start: START }),
  getConfig,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  if (getConfig) gladys.getConfig = getConfig;
  world.clock = clock;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new App({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    transport: world.transport,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
  });
  registerHandlers(gladys, app, { error: log });
  async function wait(ms) {
    for (let t = 0; t < ms; t += 10) {
      await clock.advance(Math.min(10, ms - t));
      await settle(3);
    }
    await settle();
  }
  /** Connects as the SDK does ('connected' -> onConnected), then lets 1 s pass. */
  const start = async () => {
    app.onConnected(() => gladys.getConfig()).catch(() => {});
    await wait(1000);
  };
  /** Awaits a promise while the virtual clock moves (10 ms steps). */
  const act = async (promise, max = 60_000) => {
    let done = false;
    const result = promise.then(
      (value) => {
        done = true;
        return { value };
      },
      (error) => {
        done = true;
        return { error };
      },
    );
    await settle();
    for (let t = 0; !done && t < max; t += 10) {
      await clock.advance(10);
      await settle(3);
    }
    if (!done) throw new Error('the promise did not settle');
    const { value, error } = await result;
    if (error) throw error;
    return value;
  };
  /** A command through the fake Gladys; its ack awaited while the clock moves. */
  const cmd = (featureId, value, device = devices[0]) =>
    act(gladys.fake.setValue(device, { external_id: featureId }, value));
  const status = () => gladys.fake.connectionStatus;
  return { app, gladys, clock, store, world, start, wait, act, cmd, lines, status };
}

// -----------------------------------------------------------------------------
// A fake OpenRGB SDK server: controllers encoded as the protocol does, the
// packets of the client decoded and applied (direct mode, LEDs, mode,
// profile). Served two ways: an in-memory transport on the virtual clock
// (`world.transport`), or a real TCP server of the test kit (`serve()`).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { COMMANDS, COLOR_MODES, MODE_FLAGS } from '../../src/constants.js';
import { encodePacket } from '../../src/openrgb/protocol.js';

const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};
const i32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v);
  return b;
};
const str = (text) => {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([u16(bytes.length + 1), bytes, Buffer.from([0])]);
};
const rgb = (c) => Buffer.from([(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff, 0]);

/** A mode as the protocol carries it. */
export function mode(
  name,
  { flags = 0, colorMode = COLOR_MODES.NONE, colors = [], value = 0 } = {},
) {
  return {
    name,
    value,
    flags,
    speedMin: 0,
    speedMax: 0,
    brightnessMin: 0,
    brightnessMax: 0,
    colorMin: colors.length ? 1 : 0,
    colorMax: colors.length,
    speed: 0,
    brightness: 0,
    direction: 0,
    colorMode,
    colors,
  };
}

export const DIRECT = () =>
  mode('Direct', { flags: MODE_FLAGS.HAS_PER_LED_COLOR, colorMode: COLOR_MODES.PER_LED });
export const STATIC = () =>
  mode('Static', {
    flags: MODE_FLAGS.HAS_MODE_SPECIFIC_COLOR,
    colorMode: COLOR_MODES.MODE_SPECIFIC,
    colors: [0x00ff00],
  });
export const RAINBOW = () => mode('Rainbow Wave', { flags: 1 });

/** A controller: `leds` LEDs, in its Direct mode, all `color`. */
export function controller({
  name = 'Aura Motherboard',
  vendor = 'ASUS',
  serial = '',
  location = 'I2C: /dev/i2c-1, address 0x4E',
  type = 0,
  leds = 4,
  color = 0xff0000,
  modes = [DIRECT(), STATIC(), RAINBOW()],
  activeMode = 0,
  matrix = false,
} = {}) {
  return {
    name,
    vendor,
    description: 'ASUS Aura',
    version: '1.0',
    serial,
    location,
    type,
    modes,
    activeMode,
    matrix,
    leds,
    colors: Array.from({ length: leds }, () => color),
  };
}

export function encodeController(c, version) {
  const parts = [i32(c.type), str(c.name)];
  if (version >= 1) parts.push(str(c.vendor));
  parts.push(str(c.description), str(c.version), str(c.serial), str(c.location));
  parts.push(u16(c.modes.length), i32(c.activeMode));
  for (const m of c.modes) {
    parts.push(str(m.name), i32(m.value), u32(m.flags), u32(m.speedMin), u32(m.speedMax));
    if (version >= 3) parts.push(u32(m.brightnessMin), u32(m.brightnessMax));
    parts.push(u32(m.colorMin), u32(m.colorMax), u32(m.speed));
    if (version >= 3) parts.push(u32(m.brightness));
    parts.push(u32(m.direction), u32(m.colorMode), u16(m.colors.length), ...m.colors.map(rgb));
  }
  parts.push(u16(1), str('Zone'), i32(1), u32(c.leds), u32(c.leds), u32(c.leds));
  if (c.matrix) {
    const h = 2;
    const w = Math.ceil(c.leds / 2);
    parts.push(u16(8 + 4 * h * w), u32(h), u32(w));
    for (let i = 0; i < h * w; i += 1) parts.push(u32(i < c.leds ? i : 0xffffffff));
  } else {
    parts.push(u16(0));
  }
  if (version >= 4) parts.push(u16(0));
  if (version >= 5) parts.push(u32(0));
  parts.push(u16(c.leds));
  for (let i = 0; i < c.leds; i += 1) parts.push(str(`LED ${i + 1}`), u32(i));
  parts.push(u16(c.colors.length), ...c.colors.map(rgb));
  if (version >= 5) parts.push(u16(0), u32(0));
  const data = Buffer.concat(parts);
  return Buffer.concat([u32(data.length + 4), data]);
}

export function encodeProfiles(names) {
  const data = Buffer.concat([u16(names.length), ...names.map(str)]);
  return Buffer.concat([u32(data.length + 4), data]);
}

/** Reads a mode out of an UPDATE_MODE body (the fake applies it). */
function decodeMode(body) {
  let at = 4;
  const id = body.readUInt32LE(at);
  at += 4;
  const len = body.readUInt16LE(at);
  at += 2;
  const name = body.subarray(at, at + len - 1).toString('utf8');
  return { id, name };
}

/**
 * The server. `world.controllers`, `world.profiles`, `world.version` (the protocol it speaks,
 * 0 = never answers the version), `world.log` (packets received: { command, index, body }).
 * Behaviors: `refuse` (connection refused), `silent` (reads nothing back), `stallOn(packet)`
 * (no answer to that one), `applyLeds = false` (ignores the LED writes), `latency` (ms).
 */
export function fakeOpenRGB({
  controllers = [controller()],
  profiles = ['Day', 'Night'],
  version = 5,
} = {}) {
  const world = {
    controllers,
    profiles,
    version,
    log: [],
    connections: 0,
    open: 0,
    refuse: false,
    silent: false,
    stallOn: undefined,
    applyLeds: true,
    applyModes: true,
    latency: 0,
    clock: undefined,
    sockets: new Set(),
  };

  /** Handles one packet; returns the answer buffer or undefined. */
  world.handle = (command, index, body, conn) => {
    world.log.push({ command, index, body, conn });
    if (world.silent || world.stallOn?.({ command, index, body })) return undefined;
    switch (command) {
      case COMMANDS.REQUEST_PROTOCOL_VERSION:
        if (world.version === 0) return undefined;
        conn.version = Math.min(world.version, body.readUInt32LE(0));
        return encodePacket(command, 0, u32(world.version));
      case COMMANDS.REQUEST_CONTROLLER_COUNT:
        return encodePacket(command, 0, u32(world.controllers.length));
      case COMMANDS.REQUEST_CONTROLLER_DATA: {
        const c = world.controllers[index];
        if (!c) return undefined;
        return encodePacket(command, index, encodeController(c, body.readUInt32LE(0)));
      }
      case COMMANDS.REQUEST_PROFILE_LIST:
        return encodePacket(command, 0, encodeProfiles(world.profiles));
      case COMMANDS.SET_CUSTOM_MODE: {
        const c = world.controllers[index];
        if (c && world.applyModes) {
          const direct = c.modes.findIndex((m) => m.name === 'Direct');
          if (direct >= 0) c.activeMode = direct;
        }
        return undefined;
      }
      case COMMANDS.UPDATE_LEDS: {
        const c = world.controllers[index];
        if (!c || !world.applyLeds) return undefined;
        const count = body.readUInt16LE(4);
        for (let i = 0; i < count && i < c.colors.length; i += 1) {
          const at = 6 + 4 * i;
          c.colors[i] = (body[at] << 16) | (body[at + 1] << 8) | body[at + 2];
        }
        return undefined;
      }
      case COMMANDS.UPDATE_MODE: {
        const c = world.controllers[index];
        if (c && world.applyModes) c.activeMode = decodeMode(body).id;
        return undefined;
      }
      case COMMANDS.LOAD_PROFILE:
        world.loaded = body.subarray(0, body.length - 1).toString('utf8');
        return undefined;
      default:
        return undefined;
    }
  };

  /** Feeds bytes of one connection; returns the answers (whole packets). */
  world.feed = (conn, chunk) => {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    const answers = [];
    while (conn.buffer.length >= 16) {
      const length = conn.buffer.readUInt32LE(12);
      if (conn.buffer.length < 16 + length) break;
      const command = conn.buffer.readUInt32LE(8);
      const index = conn.buffer.readUInt32LE(4);
      const body = conn.buffer.subarray(16, 16 + length);
      conn.buffer = conn.buffer.subarray(16 + length);
      const answer = world.handle(command, index, Buffer.from(body), conn);
      if (answer) answers.push(answer);
    }
    return answers;
  };

  /** Packets of a command id received. */
  world.sent = (command, index) =>
    world.log.filter((p) => p.command === command && (index === undefined || p.index === index));

  /** The in-memory transport, on the virtual clock (`world.clock`). */
  world.transport = {
    connect() {
      const socket = new EventEmitter();
      const conn = { buffer: Buffer.alloc(0), version: 0 };
      const later = (fn, ms = 0) => world.clock.timers.setTimeout(fn, ms);
      socket.destroyed = false;
      socket.setNoDelay = () => {};
      socket.write = (data) => {
        if (socket.destroyed) return false;
        const answers = world.feed(conn, Buffer.from(data));
        for (const answer of answers) {
          later(() => {
            if (!socket.destroyed) socket.emit('data', answer);
          }, world.latency);
        }
        return true;
      };
      socket.destroy = () => {
        if (socket.destroyed) return;
        socket.destroyed = true;
        world.open -= 1;
        world.sockets.delete(socket);
        later(() => socket.emit('close'));
      };
      socket.end = socket.destroy;
      world.connections += 1;
      if (world.refuse) {
        later(() => {
          const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
          socket.emit('error', err);
        });
        socket.destroyed = true;
        world.connections -= 1;
        world.refused = (world.refused ?? 0) + 1;
        return socket;
      }
      world.open += 1;
      world.sockets.add(socket);
      later(() => socket.emit('connect'));
      return socket;
    },
  };

  /** Pushes a packet to every open connection (DEVICE_LIST_UPDATED, garbage). */
  world.push = (data) => {
    for (const socket of world.sockets) socket.emit('data', data);
  };

  return world;
}

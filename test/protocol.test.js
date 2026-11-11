import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, LIMITS } from '../src/constants.js';
import * as P from '../src/openrgb/protocol.js';
import { controllerId, stateOf, controllable, modeNames } from '../src/model.js';
import {
  STATIC,
  controller,
  encodeController,
  encodeProfiles,
  mode,
} from './helpers/fakeOpenRGB.js';

test('a controller reads back the same at every protocol version, matrix included', () => {
  for (const version of [0, 1, 2, 3, 4, 5]) {
    for (const matrix of [false, true]) {
      const c = controller({ matrix, leds: 5, serial: 'ABC' });
      const read = P.parseController(encodeController(c, version), version);
      assert.equal(read.name, c.name);
      assert.equal(read.vendor, version >= 1 ? 'ASUS' : '');
      assert.equal(read.serial, 'ABC');
      assert.equal(read.ledCount, 5);
      assert.deepEqual(read.colors, c.colors);
      assert.equal(read.modes.length, 3);
      assert.equal(read.modes[1].name, 'Static');
      assert.deepEqual(read.modes[1].colors, [0x00ff00]);
      assert.equal(read.modes[0].brightness, version >= 3 ? 0 : undefined);
    }
  }
});

test('a body cut short, too long or lying about its size is refused, never read past', () => {
  const body = encodeController(controller(), 5);
  for (const cut of [3, 10, 40, body.length - 1]) {
    assert.throws(() => P.parseController(body.subarray(0, cut), 5), P.ProtocolError);
  }
  const longer = Buffer.concat([body, Buffer.alloc(4)]);
  assert.throws(() => P.parseController(longer, 5), /size/);
  longer.writeUInt32LE(longer.length, 0);
  assert.throws(() => P.parseController(longer, 5), /bytes left/);
  // A version mismatch is a size mismatch, not garbage published.
  assert.throws(() => P.parseController(body, 3), P.ProtocolError);
});

test('counts and strings over the limits are refused', () => {
  const many = controller({
    modes: Array.from({ length: LIMITS.modes + 1 }, (_, i) => mode(`M${i}`)),
  });
  assert.throws(() => P.parseController(encodeController(many, 5), 5), /too many modes/);
  const long = controller({ name: 'x'.repeat(LIMITS.stringBytes + 1) });
  assert.throws(() => P.parseController(encodeController(long, 5), 5), /string too long/);
  const leds = controller({ leds: LIMITS.leds + 1 });
  assert.throws(() => P.parseController(encodeController(leds, 5), 5), /too many/);
});

test('names lose their control characters; profiles read back', () => {
  const c = P.parseController(encodeController(controller({ name: 'Key\u0007board\n' }), 5), 5);
  assert.equal(c.name, 'Key board');
  assert.deepEqual(P.parseProfiles(encodeProfiles(['Day', 'Nuit étoilée'])), [
    'Day',
    'Nuit étoilée',
  ]);
  assert.throws(() => P.parseProfiles(encodeProfiles(['Day']).subarray(0, 7)), P.ProtocolError);
});

test('headers: not ours or too large is refused before the body', () => {
  assert.equal(P.decodeHeader(Buffer.from('ORGB')), undefined);
  assert.throws(() => P.decodeHeader(Buffer.from('HTTP/1.1 200 OK\r\n\r\n')), /not an OpenRGB/);
  const big = P.encodePacket(COMMANDS.REQUEST_CONTROLLER_DATA, 0);
  big.writeUInt32LE(LIMITS.packetBytes + 1, 12);
  assert.throws(() => P.decodeHeader(big), /too large/);
});

test('the packets written: LEDs, mode (by its read values), profile, client name', () => {
  const leds = P.updateLeds(2, 3, 0x123456);
  assert.equal(leds.readUInt32LE(4), 2);
  assert.equal(leds.readUInt32LE(8), COMMANDS.UPDATE_LEDS);
  assert.equal(leds.readUInt32LE(16), leds.length - 16);
  assert.equal(leds.readUInt16LE(20), 3);
  assert.deepEqual([...leds.subarray(22, 26)], [0x12, 0x34, 0x56, 0]);
  const m = { ...STATIC(), id: 1 };
  const packet = P.updateMode(0, m, 5);
  const body = packet.subarray(16);
  assert.equal(body.readUInt32LE(0), body.length);
  assert.equal(body.readUInt32LE(4), 1);
  assert.equal(body.readUInt16LE(8), 7);
  assert.equal(body.subarray(10, 17).toString(), 'Static\u0000');
  assert.equal(body.length, 4 + 4 + 2 + 7 + 12 * 4 + 2 + 4);
  assert.equal(P.updateMode(0, m, 2).length - 16, 4 + 4 + 2 + 7 + 9 * 4 + 2 + 4);
  const profile = P.loadProfile('Nuit');
  assert.equal(profile.subarray(16).toString(), 'Nuit\u0000');
  assert.equal(P.setClientName('Gladys').readUInt32LE(12), 7);
});

test('the id: serial first, else the location; the index never counts', () => {
  const a = P.parseController(encodeController(controller({ serial: 'S1' }), 5), 5);
  const b = P.parseController(
    encodeController(controller({ serial: 'S1', location: 'HID: /dev/hidraw9' }), 5),
    5,
  );
  assert.equal(controllerId(a), controllerId(b));
  const c = P.parseController(encodeController(controller(), 5), 5);
  const d = P.parseController(
    encodeController(controller({ location: 'I2C: /dev/i2c-2, address 0x4E' }), 5),
    5,
  );
  assert.notEqual(controllerId(c), controllerId(d));
  assert.match(controllerId(c), /^[0-9a-f]{12}$/);
});

test('states: black per-LED is off, a mode named Off is off, an effect is on with its color', () => {
  const read = (c) => stateOf(P.parseController(encodeController(c, 5), 5));
  assert.deepEqual(read(controller({ color: 0 })), { on: false, color: undefined, mode: 'Direct' });
  assert.deepEqual(read(controller({ color: 0x0000ff })), {
    on: true,
    color: 0x0000ff,
    mode: 'Direct',
  });
  assert.deepEqual(read(controller({ activeMode: 1 })), {
    on: true,
    color: 0x00ff00,
    mode: 'Static',
  });
  assert.deepEqual(read(controller({ activeMode: 2 })), {
    on: true,
    color: undefined,
    mode: 'Rainbow Wave',
  });
  const off = controller({ modes: [...controller().modes, mode('Off')], activeMode: 3 });
  assert.equal(read(off).on, false);
  // A mode index out of range tells nothing.
  assert.deepEqual(read(controller({ activeMode: 9 })), {
    on: undefined,
    color: undefined,
    mode: undefined,
  });
  const mixed = controller({ leds: 3 });
  mixed.colors = [0, 0x111111, 0x111111];
  assert.equal(read(mixed).color, 0x111111);
});

test('a controller without a per-LED color mode is not controllable; mode names unique', () => {
  const parse = (c) => P.parseController(encodeController(c, 5), 5);
  assert.equal(controllable(parse(controller({ modes: [STATIC()] }))), false);
  assert.equal(controllable(parse(controller({ leds: 0 }))), false);
  assert.deepEqual(
    modeNames(parse(controller({ modes: [mode('A'), mode('A'), mode(' '), mode('B')] }))),
    ['A', 'B'],
  );
});

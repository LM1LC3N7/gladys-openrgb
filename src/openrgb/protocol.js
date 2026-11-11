// -----------------------------------------------------------------------------
// The OpenRGB SDK protocol: packets (a 16-byte header `ORGB`, device index,
// packet id, body length, all little-endian) and the bodies this integration
// reads or writes. Layouts read from the MIT client openrgb-sdk 0.6.1 (see
// THIRD_PARTY_NOTICES.md), written again here with bounds: every count and
// length is checked against what is left and against LIMITS, a body that ends
// early or goes past its own size is refused (never read past), strings are
// decoded as UTF-8 without their final NUL.
// -----------------------------------------------------------------------------

import { COMMANDS, HEADER_SIZE, LIMITS, MAGIC } from '../constants.js';

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = 'protocol';
  }
}

/** A packet: header + body. */
export function encodePacket(command, index = 0, body = Buffer.alloc(0)) {
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(index >>> 0, 4);
  header.writeUInt32LE(command, 8);
  header.writeUInt32LE(body.length, 12);
  return Buffer.concat([header, body]);
}

/** The header at the start of `buffer`, or undefined when not all there; throws when not ours. */
export function decodeHeader(buffer) {
  if (buffer.length < HEADER_SIZE) return undefined;
  if (!buffer.subarray(0, 4).equals(MAGIC)) throw new ProtocolError('not an OpenRGB packet');
  const length = buffer.readUInt32LE(12);
  if (length > LIMITS.packetBytes) throw new ProtocolError('packet too large');
  return { index: buffer.readUInt32LE(4), command: buffer.readUInt32LE(8), length };
}

const u32 = (value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0);
  return b;
};

/** A NUL-terminated string as the protocol wants it: the bytes then a NUL, nothing more. */
export const cString = (text) => Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);

export const requestProtocolVersion = (version) =>
  encodePacket(COMMANDS.REQUEST_PROTOCOL_VERSION, 0, u32(version));
export const setClientName = (name) => encodePacket(COMMANDS.SET_CLIENT_NAME, 0, cString(name));
export const requestControllerCount = () => encodePacket(COMMANDS.REQUEST_CONTROLLER_COUNT);
export const requestControllerData = (index, version) =>
  encodePacket(COMMANDS.REQUEST_CONTROLLER_DATA, index, u32(version));
export const requestProfileList = () => encodePacket(COMMANDS.REQUEST_PROFILE_LIST);
export const loadProfile = (name) => encodePacket(COMMANDS.LOAD_PROFILE, 0, cString(name));
export const setCustomMode = (index) => encodePacket(COMMANDS.SET_CUSTOM_MODE, index);

/** Every LED of a controller to one color: size, count, then R G B and a pad byte each. */
export function updateLeds(index, count, color) {
  const body = Buffer.alloc(4 + 2 + 4 * count);
  body.writeUInt32LE(body.length, 0);
  body.writeUInt16LE(count, 4);
  for (let i = 0; i < count; i += 1) {
    const at = 6 + 4 * i;
    body[at] = (color >> 16) & 0xff;
    body[at + 1] = (color >> 8) & 0xff;
    body[at + 2] = color & 0xff;
  }
  return encodePacket(COMMANDS.UPDATE_LEDS, index, body);
}

/**
 * A mode made active (not saved to the device), with the values read just before: its id,
 * its name, its parameters as they are, its colors.
 */
export function updateMode(index, mode, version) {
  const name = Buffer.from(mode.name, 'utf8');
  const fields =
    version >= 3
      ? [
          mode.value,
          mode.flags,
          mode.speedMin,
          mode.speedMax,
          mode.brightnessMin,
          mode.brightnessMax,
          mode.colorMin,
          mode.colorMax,
          mode.speed,
          mode.brightness,
          mode.direction,
          mode.colorMode,
        ]
      : [
          mode.value,
          mode.flags,
          mode.speedMin,
          mode.speedMax,
          mode.colorMin,
          mode.colorMax,
          mode.speed,
          mode.direction,
          mode.colorMode,
        ];
  const parts = [u32(mode.id), Buffer.alloc(2), name, Buffer.from([0])];
  parts[1].writeUInt16LE(name.length + 1);
  for (const value of fields) parts.push(u32(value));
  const colors = Buffer.alloc(2 + 4 * mode.colors.length);
  colors.writeUInt16LE(mode.colors.length);
  mode.colors.forEach((c, i) => {
    colors[2 + 4 * i] = (c >> 16) & 0xff;
    colors[3 + 4 * i] = (c >> 8) & 0xff;
    colors[4 + 4 * i] = c & 0xff;
  });
  parts.push(colors);
  const data = Buffer.concat(parts);
  return encodePacket(COMMANDS.UPDATE_MODE, index, Buffer.concat([u32(data.length + 4), data]));
}

/** A bounded reader over one body: every read checks what is left. */
class Reader {
  constructor(buffer) {
    this.buffer = buffer;
    this.at = 0;
  }
  need(n) {
    if (this.at + n > this.buffer.length) throw new ProtocolError('body ends early');
  }
  u8() {
    this.need(1);
    return this.buffer[this.at++];
  }
  u16() {
    this.need(2);
    const v = this.buffer.readUInt16LE(this.at);
    this.at += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.buffer.readUInt32LE(this.at);
    this.at += 4;
    return v;
  }
  i32() {
    this.need(4);
    const v = this.buffer.readInt32LE(this.at);
    this.at += 4;
    return v;
  }
  count(max, what) {
    const n = this.u16();
    if (n > max) throw new ProtocolError(`too many ${what}`);
    return n;
  }
  string() {
    const length = this.u16();
    if (length > LIMITS.stringBytes) throw new ProtocolError('string too long');
    this.need(length);
    let bytes = this.buffer.subarray(this.at, this.at + length);
    this.at += length;
    if (bytes.length > 0 && bytes[bytes.length - 1] === 0) bytes = bytes.subarray(0, -1);
    return clean(bytes.toString('utf8'));
  }
  color() {
    this.need(4);
    const b = this.buffer;
    const c = (b[this.at] << 16) | (b[this.at + 1] << 8) | b[this.at + 2];
    this.at += 4;
    return c;
  }
}

/** Control characters out (a name shown in Gladys), trimmed. */
// eslint-disable-next-line no-control-regex
const clean = (text) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();

/** A uint32 answer (count, protocol version). */
export function parseUint32(body) {
  if (body.length < 4) throw new ProtocolError('body ends early');
  return body.readUInt32LE(0);
}

/** The body of REQUEST_CONTROLLER_DATA, for the protocol version agreed on. */
export function parseController(body, version) {
  const r = new Reader(body);
  const size = r.u32();
  if (size !== body.length) throw new ProtocolError('size does not match');
  const controller = { type: r.i32(), name: r.string() };
  controller.vendor = version >= 1 ? r.string() : '';
  controller.description = r.string();
  controller.version = r.string();
  controller.serial = r.string();
  controller.location = r.string();
  const modeCount = r.count(LIMITS.modes, 'modes');
  controller.activeMode = r.i32();
  controller.modes = [];
  for (let id = 0; id < modeCount; id += 1) {
    const mode = { id, name: r.string(), value: r.i32() };
    mode.flags = r.u32();
    mode.speedMin = r.u32();
    mode.speedMax = r.u32();
    if (version >= 3) {
      mode.brightnessMin = r.u32();
      mode.brightnessMax = r.u32();
    }
    mode.colorMin = r.u32();
    mode.colorMax = r.u32();
    mode.speed = r.u32();
    if (version >= 3) mode.brightness = r.u32();
    mode.direction = r.u32();
    mode.colorMode = r.u32();
    const colors = r.count(LIMITS.leds, 'mode colors');
    mode.colors = [];
    for (let i = 0; i < colors; i += 1) mode.colors.push(r.color());
    controller.modes.push(mode);
  }
  const zoneCount = r.count(LIMITS.zones, 'zones');
  controller.zones = [];
  for (let z = 0; z < zoneCount; z += 1) {
    const zone = { name: r.string(), type: r.i32() };
    zone.ledsMin = r.u32();
    zone.ledsMax = r.u32();
    zone.ledsCount = r.u32();
    const matrixSize = r.u16();
    if (matrixSize > 0) {
      const height = r.u32();
      const width = r.u32();
      if (height * width > LIMITS.matrixCells || matrixSize !== 8 + 4 * height * width) {
        throw new ProtocolError('matrix does not match its size');
      }
      r.need(4 * height * width);
      r.at += 4 * height * width;
    }
    if (version >= 4) {
      const segments = r.count(LIMITS.segments, 'segments');
      for (let s = 0; s < segments; s += 1) {
        r.string();
        r.i32();
        r.u32();
        r.u32();
      }
    }
    if (version >= 5) r.u32();
    controller.zones.push(zone);
  }
  const ledCount = r.count(LIMITS.leds, 'LEDs');
  for (let i = 0; i < ledCount; i += 1) {
    r.string();
    r.u32();
  }
  controller.ledCount = ledCount;
  const colorCount = r.count(LIMITS.leds, 'colors');
  controller.colors = [];
  for (let i = 0; i < colorCount; i += 1) controller.colors.push(r.color());
  if (version >= 5) {
    const alternate = r.count(LIMITS.leds, 'LED names');
    for (let i = 0; i < alternate; i += 1) r.string();
    controller.flags = r.u32();
  }
  if (r.at !== body.length) throw new ProtocolError('bytes left after the controller');
  return controller;
}

/** The body of REQUEST_PROFILE_LIST: the names, as OpenRGB lists them. */
export function parseProfiles(body) {
  const r = new Reader(body);
  const size = r.u32();
  if (size !== body.length) throw new ProtocolError('size does not match');
  const count = r.count(LIMITS.profiles, 'profiles');
  const names = [];
  for (let i = 0; i < count; i += 1) names.push(r.string());
  if (r.at !== body.length) throw new ProtocolError('bytes left after the profiles');
  return names;
}

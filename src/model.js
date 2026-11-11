// -----------------------------------------------------------------------------
// An OpenRGB controller -> its id, its Gladys device, its states (pure).
//
// Id (frozen): the first 12 hex digits of the SHA-256 of
// `vendor NUL name NUL s:serial` when the controller has a serial, else
// `vendor NUL name NUL l:location` (the bus and address OpenRGB shows, the
// same while the hardware stays where it is). The index OpenRGB gives a
// controller changes with a rescan or a new device: it is never the id, and
// it is checked again (identity read) before every write.
// Two controllers with the same id (no serial, same location) are both left
// out: never a write on the wrong one.
//
// Feature keys (frozen): `light` light/binary, `color` light/color
// (0xRRGGBB), `mode` text/select (the modes of the controller, by name).
// The server device (`ext:<selector>:server:openrgb`) has `profile`
// text/select (the profiles saved in OpenRGB). None is a `switch`.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { COLOR_MODES, DEVICE_TYPES, MODE_FLAGS } from './constants.js';
import { FEATURE_NAMES, SERVER_NAME, word } from './i18n.js';

export const KIND = 'controller';
export const SERVER = { kind: 'server', id: 'openrgb' };
export const FEATURES = { LIGHT: 'light', COLOR: 'color', MODE: 'mode', PROFILE: 'profile' };

const ID = /^[0-9a-f]{12}$/;
export const isId = (value) => typeof value === 'string' && ID.test(value);

export function controllerId(c) {
  const where = c.serial ? `s:${c.serial}` : `l:${c.location}`;
  return createHash('sha256')
    .update(`${c.vendor}\u0000${c.name}\u0000${where}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
}

export const typeName = (type) => DEVICE_TYPES[type] ?? 'unknown';

/** The mode a color is written in exists: a mode with per-LED colors, and LEDs. */
export const controllable = (c) =>
  c.ledCount > 0 && c.modes.some((m) => (m.flags & MODE_FLAGS.HAS_PER_LED_COLOR) !== 0);

const isOffMode = (mode) => /^off$/i.test(mode?.name ?? '');

/** The most frequent color that is not black, or undefined. */
function mainColor(colors) {
  const counts = new Map();
  let best;
  for (const c of colors) {
    if (c === 0) continue;
    const n = (counts.get(c) ?? 0) + 1;
    counts.set(c, n);
    if (best === undefined || n > counts.get(best)) best = c;
  }
  return best;
}

/**
 * What a read shows: `{ on, color, mode }`, each undefined when the read does not tell.
 * Per-LED colors (the direct mode): off when every LED is black. A mode named Off: off.
 * Any other mode (an effect of the hardware): on, its color when it has one.
 */
export function stateOf(c) {
  const active = c.modes[c.activeMode];
  const state = { on: undefined, color: undefined, mode: active?.name || undefined };
  if (!active) return state;
  if (isOffMode(active)) {
    state.on = false;
  } else if (active.colorMode === COLOR_MODES.PER_LED) {
    if (c.colors.length === 0) return state;
    const color = mainColor(c.colors);
    state.on = color !== undefined;
    state.color = color;
  } else {
    state.on = true;
    if (active.colorMode === COLOR_MODES.MODE_SPECIFIC) state.color = mainColor(active.colors);
  }
  return state;
}

/** Every LED shows `color` in a per-LED mode (what a write of that color asked for). */
export const showsColor = (c, color) => {
  const active = c.modes[c.activeMode];
  return (
    active?.colorMode === COLOR_MODES.PER_LED &&
    c.colors.length > 0 &&
    c.colors.every((x) => x === color)
  );
};

/** The mode names offered (unique, non-empty, in the order of the controller). */
export const modeNames = (c) => uniqueNames(c.modes.map((m) => m.name));

/** A name as offered in a list: 60 characters at most, trimmed. */
export const shortName = (name) => [...String(name)].slice(0, 60).join('').trim();

/** Unique, non-empty names, in their order. */
export function uniqueNames(list) {
  const seen = new Set();
  const names = [];
  for (const raw of list) {
    const name = shortName(raw);
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

const options = (names) => names.map((name, i) => ({ value: name, label: name, sort_order: i }));

/**
 * The Gladys device of a controller. `created`: the device as Gladys has it; its features are
 * kept (never one lost), the mode list refreshed from the read, the new ones added.
 */
export function buildDevice(gladys, c, { id, language, address, created }) {
  const ids = gladys.externalIds(KIND, id);
  const base = (key) => ({
    name: word(FEATURE_NAMES[key], language),
    external_id: ids.feature(key),
    read_only: false,
    has_feedback: true,
  });
  const fresh = [
    {
      ...base(FEATURES.LIGHT),
      category: C.LIGHT,
      type: T.LIGHT.BINARY,
      min: 0,
      max: 1,
      keep_history: true,
    },
    {
      ...base(FEATURES.COLOR),
      category: C.LIGHT,
      type: T.LIGHT.COLOR,
      min: 0,
      max: 0xffffff,
      keep_history: false,
    },
  ];
  const modes = modeNames(c);
  if (modes.length > 0) {
    fresh.push({
      ...base(FEATURES.MODE),
      category: C.TEXT,
      type: T.TEXT.SELECT,
      min: 0,
      max: 0,
      keep_history: false,
      supported_options: options(modes),
    });
  }
  const features = [];
  const have = new Set();
  for (const feature of created?.features ?? []) {
    const key = featureKeyOf(feature?.external_id, ids.device);
    if (!key || have.has(key)) continue;
    have.add(key);
    const update =
      key === FEATURES.MODE ? fresh.find((f) => f.external_id === feature.external_id) : undefined;
    features.push(update ? { ...feature, supported_options: update.supported_options } : feature);
  }
  for (const feature of fresh) {
    if (!have.has(featureKeyOf(feature.external_id, ids.device))) features.push(feature);
  }
  const name = [c.vendor, c.name].filter(Boolean).join(' ').slice(0, 80) || typeName(c.type);
  return {
    name: created?.name ?? name,
    external_id: ids.device,
    model: typeName(c.type),
    params: [{ name: 'openrgb_server', value: address }],
    features,
  };
}

/** The feature key of an external id under a device id; undefined when not ours. */
export function featureKeyOf(externalId, deviceId) {
  if (typeof externalId !== 'string' || !externalId.startsWith(`${deviceId}:`)) return undefined;
  const key = externalId.slice(deviceId.length + 1);
  return Object.values(FEATURES).includes(key) ? key : undefined;
}

/** `ext:<selector>:controller:<id>[:<key>]` or the server -> `{ kind, id, key }`; undefined when not ours. */
export function parseExternalId(externalId, selector) {
  const prefix = `ext:${selector}:`;
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) return undefined;
  const [kind, id, key, ...rest] = externalId.slice(prefix.length).split(':');
  if (rest.length > 0) return undefined;
  if (kind === KIND && isId(id)) {
    if (key !== undefined && ![FEATURES.LIGHT, FEATURES.COLOR, FEATURES.MODE].includes(key)) {
      return undefined;
    }
    return { kind, id, key };
  }
  if (kind === SERVER.kind && id === SERVER.id && (key === undefined || key === FEATURES.PROFILE)) {
    return { kind, id, key };
  }
  return undefined;
}

/** The server device: the profiles of OpenRGB. */
export function buildServerDevice(gladys, profiles, { language, address }) {
  const ids = gladys.externalIds(SERVER.kind, SERVER.id);
  return {
    name: word(SERVER_NAME, language),
    external_id: ids.device,
    model: 'openrgb-sdk-server',
    params: [{ name: 'openrgb_server', value: address }],
    features: [
      {
        name: word(FEATURE_NAMES[FEATURES.PROFILE], language),
        external_id: ids.feature(FEATURES.PROFILE),
        category: C.TEXT,
        type: T.TEXT.SELECT,
        read_only: false,
        has_feedback: false,
        keep_history: false,
        min: 0,
        max: 0,
        supported_options: options(uniqueNames(profiles)),
      },
    ],
  };
}

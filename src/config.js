// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
//
// `server`: the address of the computer running OpenRGB with its SDK server
// (`192.168.1.20`, `pc-salon.lan`, `192.168.1.20:6743`), port 6742 unless
// given. `allow_modes` / `allow_profiles`: the writes beyond on, off and color
// (an effect mode, a whole profile), off unless the user ticks them.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { API, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  poll_interval: POLL_INTERVAL.default,
  allow_modes: false,
  allow_profiles: false,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * One address typed by the user: `{ host, port }`, `{ error: 'invalid' }` when it
 * holds a scheme, a path, a query or credentials, `{}` when empty. Taken from gladys-modern-forms 0.1.1.
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return {};
  }
  // eslint-disable-next-line no-control-regex
  if (/[/?#@\s\u0000-\u001f\u007f]/.test(text)) {
    return { error: 'invalid' };
  }
  let host = text;
  let port;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2];
  } else if (isIP(text) !== 6) {
    const withPort = /^([^:]+):(\d{1,5})$/.exec(text);
    if (withPort) {
      host = withPort[1];
      port = withPort[2];
    } else if (text.includes(':')) {
      return { error: 'invalid' };
    }
  }
  if (isIP(host) === 0 && !HOSTNAME.test(host)) {
    return { error: 'invalid' };
  }
  if (isIP(host) === 4 && /^(0\.|255\.255\.255\.255$|22[4-9]\.|23\d\.)/.test(host)) {
    // Neither "this network", the broadcast nor a multicast group.
    return { error: 'invalid' };
  }
  if (isIP(host) === 6 && /^(::$|ff)/i.test(host)) {
    // Neither the unspecified address nor a multicast group.
    return { error: 'invalid' };
  }
  const portNumber = port === undefined ? API.defaultPort : Number(port);
  if (portNumber < 1 || portNumber > 65535) {
    return { error: 'invalid' };
  }
  return { host: host.toLowerCase(), port: portNumber };
}

/** `host:port` (IPv6 in brackets): the key of an address everywhere (/data). */
export const addressKey = ({ host, port }) => `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;

/** An address key back to `{ host, port }`; undefined when it is not one. */
export function addressOf(key) {
  if (typeof key !== 'string' || key.length > 300) return undefined;
  const parsed = parseAddress(key);
  if (parsed.error || !parsed.host) return undefined;
  return addressKey(parsed) === key ? parsed : undefined;
}

const number = (value) =>
  value === undefined || value === null || value === '' ? NaN : Number(value);

const clamp = (value, { min, max }, fallback) =>
  Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;

/** A ticked box: `true` or `'true'` only (anything else, unset included, is unticked). */
const ticked = (value) => value === true || value === 'true';

export function normalizeConfig(raw = {}) {
  const parsed = parseAddress(raw?.server);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  return {
    address: parsed.host
      ? { host: parsed.host, port: parsed.port, key: addressKey(parsed) }
      : undefined,
    addressError: Boolean(parsed.error),
    pollInterval: clamp(number(raw?.poll_interval), POLL_INTERVAL, DEFAULTS.poll_interval),
    allowModes: ticked(raw?.allow_modes),
    allowProfiles: ticked(raw?.allow_profiles),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

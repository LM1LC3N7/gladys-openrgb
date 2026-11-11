// -----------------------------------------------------------------------------
// Constants: the OpenRGB SDK protocol (network protocol of the OpenRGB SDK
// server, read from the MIT client openrgb-sdk, see THIRD_PARTY_NOTICES.md),
// the bounds of what is read, and the timings of the app.
// -----------------------------------------------------------------------------

export const ACTIONS = { TEST_CONNECTION: 'test_connection' };

export const API = {
  defaultPort: 6742,
  /** The highest protocol version this client reads (OpenRGB 0.9 and 1.0 speak 4 and 5). */
  clientVersion: 5,
  /** The name shown in the SDK Server tab of OpenRGB. */
  clientName: 'Gladys',
};

/** Packet ids of the protocol (the header carries one). */
export const COMMANDS = {
  REQUEST_CONTROLLER_COUNT: 0,
  REQUEST_CONTROLLER_DATA: 1,
  REQUEST_PROTOCOL_VERSION: 40,
  SET_CLIENT_NAME: 50,
  DEVICE_LIST_UPDATED: 100,
  REQUEST_PROFILE_LIST: 150,
  LOAD_PROFILE: 152,
  UPDATE_LEDS: 1050,
  SET_CUSTOM_MODE: 1100,
  UPDATE_MODE: 1101,
};

/** Bits of a mode's flags. */
export const MODE_FLAGS = {
  HAS_BRIGHTNESS: 1 << 4,
  HAS_PER_LED_COLOR: 1 << 5,
  HAS_MODE_SPECIFIC_COLOR: 1 << 6,
};

/** Color modes of a mode. */
export const COLOR_MODES = { NONE: 0, PER_LED: 1, MODE_SPECIFIC: 2, RANDOM: 3 };

export const HEADER_SIZE = 16;
export const MAGIC = Buffer.from('ORGB', 'ascii');

/** Bounds of what is read from the server: past them, the answer is refused. */
export const LIMITS = {
  /** One packet (a keyboard with its matrix and LED names stays far below). */
  packetBytes: 1024 * 1024,
  /** Bytes waiting on the socket that no request awaits: the connection is closed. */
  bufferedBytes: 2 * 1024 * 1024,
  controllers: 64,
  modes: 128,
  zones: 64,
  segments: 64,
  leds: 4096,
  matrixCells: 65536,
  stringBytes: 512,
  profiles: 64,
  profileNameBytes: 100,
  /** Discovered and remembered devices. */
  remembered: 128,
  /** Offs kept in /data. */
  guards: 64,
  /** Commands in progress at once (an Off is never counted nor refused). */
  commands: 32,
};

export const POLL_INTERVAL = { default: 10, min: 5, max: 300 };

export const TIMINGS = {
  connect: 1500,
  /** One answer (the whole packet). */
  answer: 1500,
  /** A read stalled this long (no byte) is cut by an Off waiting for the connection. */
  stall: 1000,
  /** The command budget: Gladys gives up after 5 s, the ack must be back before. */
  command: 3000,
  /** An Off is tried again inside this budget (new connection) before being kept for later. */
  offRetry: 250,
  /**
   * An identity read on the same connection, with no DEVICE_LIST_UPDATED since, serves the
   * writes that follow until the next periodic read plus this margin (a scene on several
   * controllers is not one read each).
   */
  identityFresh: 5000,
  /** The read that confirms a command, after the write. */
  confirm: 300,
  /** Offs not shown by a read are sent again at the next reads, this many times. */
  offResends: 3,
  /** An Off kept in /data is sent again at a start only this long after it was asked (wall). */
  guardMaxAge: 10 * 60_000,
  /** Unreadable /data: read again on a timer of its own. */
  storeRetry: 10_000,
  storeWait: 2000,
  /** getConfig() failed: tried again, spaced. */
  configRetryMin: 5000,
  configRetryMax: 60_000,
  /** Wait before reconnecting after failed reads: doubled up to the max, never under the interval. */
  backoffMax: 5 * 60_000,
  /** At most so many states published per minute (Gladys allows 300). */
  statesPerMinute: 250,
};

/** OpenRGB device types 0 to 14 (enum device_type of the protocol); any other is `unknown`. */
export const DEVICE_TYPES = [
  'motherboard',
  'dram',
  'gpu',
  'cooler',
  'ledstrip',
  'keyboard',
  'mouse',
  'mousemat',
  'headset',
  'headsetStand',
  'gamepad',
  'light',
  'speaker',
  'virtual',
  'storage',
];

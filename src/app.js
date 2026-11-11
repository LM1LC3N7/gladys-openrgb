// -----------------------------------------------------------------------------
// The integration: reads the OpenRGB SDK server every interval, publishes the
// states of the controllers the user created, runs the commands.
//
// - One connection to the server (src/openrgb/client.js), one request in
//   flight, by priority: Off, then commands, then reads.
// - Off (light 0, or color 0) is the protective command: no option, no wait
//   for the configuration (the address of /data serves), never behind a read
//   (a stalled one is cut), it cancels the commands of the same controller
//   still waiting. Not shown by the read that follows, it is kept (in /data)
//   and sent again by the next reads, 3 times at most; a newer command that
//   did leave for that controller (or a profile loaded) ends its resends.
// - Every write is preceded by a read of the controller at its index (the
//   identity: same id, else the whole list is read to find it): never a write
//   on another controller. On, color and mode are confirmed only by a read
//   that shows them.
// - Mode and profile writes only when their option is ticked (checked again
//   just before the bytes leave). Nothing is ever saved to a device or to the
//   profiles of OpenRGB: no saveMode, saveProfile, deleteProfile, resize.
// - Time: `monotonic()` for every decision (periods, budgets); `now()` (wall)
//   only for /data (time of the last read attempt, so a restart never reads
//   sooner than the interval).
// -----------------------------------------------------------------------------

import { performance } from 'node:perf_hooks';
import { COMMANDS, LIMITS, TIMINGS } from './constants.js';
import { addressOf, normalizeConfig } from './config.js';
import { ANSWERS, STATUS, TEST, join, word } from './i18n.js';
import {
  FEATURES,
  KIND,
  SERVER,
  buildDevice,
  buildServerDevice,
  controllable,
  controllerId,
  modeNames,
  parseExternalId,
  shortName,
  showsColor,
  stateOf,
} from './model.js';
import { Link, LinkError, PRIORITY, tcpTransport } from './openrgb/client.js';
import * as P from './openrgb/protocol.js';
import { fileStore, normalizeMemory } from './store.js';

const WHITE = 0xffffff;

/** A refusal: nothing was sent. */
class Refusal extends Error {}

export class App {
  constructor({
    gladys,
    logger = console,
    transport = tcpTransport,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.transport = transport;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.gen = 0;
    this.config = undefined;
    this.memory = undefined;
    this.link = undefined;
    this.controllers = new Map();
    this.duplicates = new Set();
    this.lastRead = undefined;
    this.failures = 0;
    this.offSeq = new Map();
    this.timer = { poll: undefined, config: undefined, store: undefined };
    this.published = [];
    this.stopped = false;
    this.storeLoading = false;
    this.polling = undefined;
    this.activeCommands = 0;
  }

  get language() {
    return this.config?.language ?? 'fr';
  }

  text(message) {
    return word(message, this.language);
  }

  refusal(message) {
    return new Refusal(this.text(message));
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Every connection to Gladys: /data, its Offs, then the configuration (retried). */
  async onConnected(getConfig) {
    const gen = ++this.gen;
    this.stopped = false;
    for (const key of Object.keys(this.timer)) this.clear(key);
    // Nothing remembered is published again as new: the next read publishes.
    this.gladys.forgetPublishedStates?.();
    await this.loadMemory();
    if (gen !== this.gen) return;
    // The Offs kept in /data leave now, from the address of /data, before the configuration.
    if (this.memory?.guards.length && !this.link && this.memory.address) {
      this.useAddress(addressOf(this.memory.address), this.memory.address);
      this.resendOffs(gen);
    }
    await this.readConfig(getConfig, gen, TIMINGS.configRetryMin);
  }

  async readConfig(getConfig, gen, wait) {
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (gen !== this.gen) return;
      this.logger.warn?.(`Configuration not read (${err?.message ?? err})`);
      await this.status(false, STATUS.configUnread, gen);
      this.clear('config');
      this.timer.config = this.timers.setTimeout(() => {
        this.timer.config = undefined;
        this.readConfig(getConfig, gen, Math.min(wait * 2, TIMINGS.configRetryMax)).catch(() => {});
      }, wait);
      return;
    }
    if (gen !== this.gen) return;
    await this.applyConfig(raw, gen);
  }

  async configUpdated(raw) {
    if (this.stopped) return;
    this.clear('config');
    await this.applyConfig(raw, this.gen);
  }

  async applyConfig(raw, gen) {
    const before = this.config;
    const config = normalizeConfig(raw);
    this.config = config;
    if (!config.address) {
      this.closeLink();
      this.clear('poll');
      await this.status(false, config.addressError ? STATUS.badServer : STATUS.noServer, gen);
      return;
    }
    const same =
      before?.address?.key === config.address.key &&
      before?.pollInterval === config.pollInterval &&
      this.link?.key === config.address.key;
    this.useAddress(config.address, config.address.key);
    if (this.memory && this.memory.address !== config.address.key) {
      this.memory.address = config.address.key;
      this.save();
    }
    // Same server, same interval, a read already planned: nothing moves (never a read sooner).
    if (same && (this.timer.poll || this.polling)) return;
    this.planFirstRead();
  }

  /** The first read: never sooner than the interval after the last attempt (/data). */
  planFirstRead() {
    const interval = this.config.pollInterval * 1000;
    const last = this.memory?.lastAttemptAt;
    const wall = this.now();
    const wait = last === undefined ? 0 : Math.max(0, Math.min(interval, last + interval - wall));
    this.schedule(wait);
  }

  useAddress(address, key) {
    if (!address) return;
    if (this.link?.key === key) return;
    this.closeLink();
    const link = new Link({
      host: address.host,
      port: address.port,
      transport: this.transport,
      timers: this.timers,
      monotonic: this.monotonic,
    });
    link.key = key;
    this.link = link;
    this.controllers.clear();
    this.duplicates.clear();
  }

  closeLink() {
    this.link?.close();
    this.link = undefined;
  }

  clear(key) {
    if (this.timer[key]) this.timers.clearTimeout(this.timer[key]);
    this.timer[key] = undefined;
  }

  async shutdown() {
    this.stopped = true;
    this.gen += 1;
    for (const key of Object.keys(this.timer)) this.clear(key);
    this.closeLink();
    if (this.memory) await this.saveNow();
  }

  async status(connected, message, gen = this.gen) {
    if (gen !== this.gen || this.stopped) return;
    this.lastStatus = message;
    try {
      await this.gladys.setConnectionStatus(connected, message);
    } catch (err) {
      this.logger.warn?.(`Status not sent (${err?.message ?? err})`);
    }
  }

  // ---- /data -----------------------------------------------------------------

  /** Bounded: a /data that does not answer is unreadable, read again on a timer of its own. */
  async loadMemory() {
    if (this.memory || this.storeLoading) return;
    this.storeLoading = true;
    let timer;
    try {
      const raw = await Promise.race([
        this.store.load(),
        new Promise((_, reject) => {
          timer = this.timers.setTimeout(() => reject(new Error('timeout')), TIMINGS.storeWait);
        }),
      ]);
      this.memory = normalizeMemory(raw, this.now());
      for (const guard of this.memory.guards) this.offSeq.set(guard.id, 0);
    } catch (err) {
      this.logger.warn?.(`/data not read (${err?.code ?? err?.message ?? err})`);
      this.clear('store');
      this.timer.store = this.timers.setTimeout(() => {
        this.timer.store = undefined;
        this.loadMemory().catch(() => {});
      }, TIMINGS.storeRetry);
    } finally {
      this.timers.clearTimeout(timer);
      this.storeLoading = false;
    }
  }

  /** Saves in the background (never awaited on the way of a command). */
  save() {
    this.saveNow().catch(() => {});
  }

  async saveNow() {
    // Unread /data is never overwritten.
    if (!this.memory) return false;
    let timer;
    try {
      await Promise.race([
        this.store.save(this.memory),
        new Promise((_, reject) => {
          timer = this.timers.setTimeout(() => reject(new Error('timeout')), TIMINGS.storeWait);
        }),
      ]);
      return true;
    } catch (err) {
      this.logger.warn?.(`/data not written (${err?.code ?? err?.message ?? err})`);
      return false;
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  remember(id) {
    if (!this.memory) return undefined;
    if (!this.memory.devices[id]) {
      if (Object.keys(this.memory.devices).length >= LIMITS.remembered) return undefined;
      this.memory.devices[id] = {};
    }
    return this.memory.devices[id];
  }

  // ---- reads -----------------------------------------------------------------

  schedule(wait) {
    this.clear('poll');
    if (this.stopped) return;
    this.timer.poll = this.timers.setTimeout(() => {
      this.timer.poll = undefined;
      this.poll().catch((err) => this.logger.error?.('Read failed', err));
    }, wait);
  }

  /** One read of every controller; the next one planned from the start of this one. */
  async poll() {
    if (this.polling || !this.link || !this.config) return this.polling;
    const gen = this.gen;
    const link = this.link;
    const started = this.monotonic();
    const interval = this.config.pollInterval * 1000;
    this.polling = (async () => {
      if (this.memory) {
        this.memory.lastAttemptAt = this.now();
        await this.saveNow();
      }
      let wait = interval;
      try {
        const list = await this.readAll(link, PRIORITY.READ);
        if (gen !== this.gen || link !== this.link) return;
        this.failures = 0;
        this.lastRead = { at: started, list, count: list.found.size, skipped: list.skipped };
        await this.publishStates(list);
        await this.checkOffs(list, gen);
        const message = list.skipped
          ? join(STATUS.connected(list.found.size), STATUS.skipped(list.skipped))
          : STATUS.connected(list.found.size);
        await this.status(true, message, gen);
      } catch (err) {
        if (gen !== this.gen || link !== this.link) return;
        if (err?.code === 'cut') {
          // Cut by an Off: not a failure of the server, read again at the next interval.
        } else {
          this.failures += 1;
          wait = Math.min(interval * 2 ** Math.min(this.failures - 1, 10), TIMINGS.backoffMax);
          wait = Math.max(wait, interval);
          this.lastRead = { at: started, error: err };
          this.logger.warn?.(`Read failed (${err?.code ?? 'error'}: ${err?.message ?? err})`);
          const cause = err?.code === 'protocol' ? STATUS.protocol : STATUS.unreachable;
          await this.status(false, join(cause, STATUS.retry(Math.round(wait / 1000))), gen);
          // The Offs waiting are tried at every read, failed ones included.
          await this.checkOffs(undefined, gen);
        }
      }
      if (gen === this.gen && link === this.link) {
        const elapsed = this.monotonic() - started;
        this.schedule(Math.max(0, wait - elapsed));
      }
    })();
    try {
      await this.polling;
    } finally {
      this.polling = undefined;
    }
  }

  async readCount(link, priority, extra) {
    const { body } = await link.request(P.requestControllerCount(), {
      expect: COMMANDS.REQUEST_CONTROLLER_COUNT,
      priority,
      ...extra,
    });
    const count = P.parseUint32(body);
    if (count > LIMITS.controllers) throw new LinkError('protocol', 'too many controllers');
    return count;
  }

  async readController(link, index, priority, extra) {
    const { body, version } = await link.request((v) => P.requestControllerData(index, v), {
      expect: COMMANDS.REQUEST_CONTROLLER_DATA,
      index,
      priority,
      ...extra,
    });
    try {
      return P.parseController(body, version);
    } catch (err) {
      throw new LinkError('protocol', err.message);
    }
  }

  /** Every controller: `{ found: Map(id -> { index, c }), skipped }`; the doubles left out. */
  async readAll(link, priority, extra) {
    const count = await this.readCount(link, priority, extra);
    const byId = new Map();
    const dupes = new Set();
    let skipped = 0;
    for (let index = 0; index < count; index += 1) {
      const c = await this.readController(link, index, priority, extra);
      if (!controllable(c)) {
        skipped += 1;
        continue;
      }
      const id = controllerId(c);
      if (byId.has(id) || dupes.has(id)) {
        dupes.add(id);
        byId.delete(id);
        skipped += 1;
        continue;
      }
      byId.set(id, { index, c });
    }
    skipped += [...dupes].length;
    if (link === this.link) {
      this.controllers = byId;
      this.duplicates = dupes;
      let changed = false;
      for (const [id, { index, c }] of byId) {
        const entry = this.remember(id);
        if (!entry) continue;
        if (entry.index !== index) {
          entry.index = index;
          changed = true;
        }
        const state = stateOf(c);
        if (state.on && state.color !== undefined && entry.color !== state.color) {
          entry.color = state.color;
          changed = true;
        }
      }
      if (changed) this.save();
    }
    return { found: byId, skipped };
  }

  /** Our devices Gladys has (created by the user): their ids. */
  createdIds() {
    const ids = new Set();
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseExternalId(device?.external_id, this.gladys.selector);
      if (parsed?.kind === KIND) ids.add(parsed.id);
    }
    return ids;
  }

  statesOf(id, c) {
    const ids = this.gladys.externalIds(KIND, id);
    const state = stateOf(c);
    const out = [];
    if (state.on !== undefined) {
      out.push({
        device_feature_external_id: ids.feature(FEATURES.LIGHT),
        state: state.on ? 1 : 0,
      });
    }
    if (state.color !== undefined) {
      out.push({ device_feature_external_id: ids.feature(FEATURES.COLOR), state: state.color });
    }
    const mode = state.mode === undefined ? undefined : shortName(state.mode);
    if (mode && modeNames(c).includes(mode)) {
      out.push({ device_feature_external_id: ids.feature(FEATURES.MODE), text: mode });
    }
    return out;
  }

  async publishStates(list) {
    const created = this.createdIds();
    const states = [];
    for (const [id, { c }] of list.found) {
      if (created.has(id)) states.push(...this.statesOf(id, c));
    }
    await this.publish(states);
  }

  /** Changed states only, within the budget per minute (the rest goes at the next read). */
  async publish(states) {
    if (states.length === 0) return;
    const at = this.monotonic();
    this.published = this.published.filter((t) => at - t < 60_000);
    const room = Math.max(0, TIMINGS.statesPerMinute - this.published.length);
    const batch = states.slice(0, room);
    if (batch.length === 0) return;
    try {
      const sent = await this.gladys.publishChangedStates(batch);
      const count = Number.isInteger(sent?.count) ? sent.count : batch.length;
      for (let i = 0; i < count; i += 1) this.published.push(at);
    } catch (err) {
      this.logger.warn?.(`States not published (${err?.message ?? err})`);
    }
  }

  // ---- Offs ------------------------------------------------------------------

  guardOf(id) {
    return this.memory?.guards.find((g) => g.id === id) ?? this.guards?.get(id);
  }

  /** The Off kept (in /data when read, else in memory only: never blocked by /data). */
  keepGuard(id) {
    if (this.memory) {
      if (!this.memory.guards.some((g) => g.id === id)) {
        if (this.memory.guards.length >= LIMITS.guards) this.memory.guards.shift();
        this.memory.guards.push({ id, resends: 0 });
      } else {
        this.memory.guards.find((g) => g.id === id).resends = 0;
      }
      this.save();
    } else {
      this.guards ??= new Map();
      this.guards.set(id, { id, resends: 0 });
    }
  }

  dropGuard(id) {
    this.guards?.delete(id);
    if (!this.memory) return;
    const before = this.memory.guards.length;
    this.memory.guards = this.memory.guards.filter((g) => g.id !== id);
    if (this.memory.guards.length !== before) this.save();
  }

  allGuards() {
    const list = [...(this.memory?.guards ?? [])];
    for (const guard of this.guards?.values() ?? []) {
      if (!list.some((g) => g.id === guard.id)) list.push(guard);
    }
    return list;
  }

  /** After a read: an Off shown is done; one not shown is sent again (3 times at most). */
  async checkOffs(list, gen) {
    for (const guard of this.allGuards()) {
      if (gen !== this.gen) return;
      const seen = list?.found.get(guard.id);
      if (seen && stateOf(seen.c).on === false) {
        this.dropGuard(guard.id);
        continue;
      }
      if (guard.resends >= TIMINGS.offResends) {
        this.logger.warn?.(`Off of ${guard.id} not shown after ${guard.resends} resends: given up`);
        this.dropGuard(guard.id);
        continue;
      }
      guard.resends += 1;
      if (this.memory) this.save();
      await this.sendOff(guard.id, { resend: true }).catch(() => {});
    }
  }

  /** The Offs of /data, at start (before the configuration is read). */
  resendOffs(gen) {
    for (const guard of this.allGuards()) {
      if (gen !== this.gen) return;
      this.sendOff(guard.id, { resend: true }).catch(() => {});
    }
  }

  /**
   * One Off: identity read, direct mode, every LED black, then a read that shows it or not.
   * Tried again once inside its budget (a new connection) before being kept for the reads.
   */
  async sendOff(id, { resend = false, flow = {} } = {}) {
    const deadline = this.monotonic() + TIMINGS.offRetry;
    for (let attempt = 0; ; attempt += 1) {
      const link = this.link;
      if (!link) return 'waiting';
      const release = link.reserve();
      try {
        const at = await this.locate(link, id, PRIORITY.OFF);
        if (!at) return 'notFound';
        const extra = { priority: PRIORITY.OFF, target: id, index: at.index };
        await link.request(P.setCustomMode(at.index), extra);
        await link.request(P.updateLeds(at.index, at.c.ledCount, 0), {
          ...extra,
          sent: () => {
            flow.sent = true;
          },
        });
        release();
        if (!resend) this.logger.info?.(`Off sent to ${id}`);
        const after = await this.confirmRead(link, at.index, id, PRIORITY.OFF);
        if (after && stateOf(after).on === false) {
          this.dropGuard(id);
          return 'confirmed';
        }
        return 'kept';
      } catch (err) {
        if (attempt === 0 && this.monotonic() < deadline && err?.code !== 'protocol') continue;
        return 'waiting';
      } finally {
        release();
      }
    }
  }

  /** The controller at its index (identity checked), else found in the whole list. */
  async locate(link, id, priority, extra) {
    if (this.duplicates.has(id)) return undefined;
    const known = this.controllers.get(id)?.index ?? this.memory?.devices[id]?.index;
    if (known !== undefined) {
      const count = await this.readCount(link, priority, extra);
      if (known < count) {
        const c = await this.readController(link, known, priority, extra);
        if (controllable(c) && controllerId(c) === id) return { index: known, c };
      }
    }
    const list = await this.readAll(link, priority, extra);
    return list.found.get(id);
  }

  /** The read after a write, a moment later; undefined when it fails or is another controller. */
  async confirmRead(link, index, id, priority) {
    await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.confirm));
    try {
      const c = await this.readController(link, index, priority);
      if (controllerId(c) !== id) return undefined;
      const entry = this.controllers.get(id);
      if (entry && link === this.link) entry.c = c;
      if (this.createdIds().has(id)) await this.publish(this.statesOf(id, c));
      return c;
    } catch {
      return undefined;
    }
  }

  // ---- commands ----------------------------------------------------------------

  async setValue(device, feature, value) {
    const parsed = parseExternalId(feature?.external_id, this.gladys.selector);
    if (!parsed?.key) throw this.refusal(ANSWERS.badValue);
    if (parsed.kind === SERVER.kind) return this.loadProfile(value);
    const { id, key } = parsed;
    if (key === FEATURES.LIGHT || key === FEATURES.COLOR) {
      const number = typeof value === 'number' ? value : Number.NaN;
      if (!Number.isInteger(number) || number < 0) throw this.refusal(ANSWERS.badValue);
      if (key === FEATURES.LIGHT && number > 1) throw this.refusal(ANSWERS.badValue);
      if (key === FEATURES.COLOR && number > 0xffffff) throw this.refusal(ANSWERS.badValue);
      if (number === 0) return this.off(id);
      return this.command(id, { color: key === FEATURES.COLOR ? number : undefined });
    }
    if (typeof value !== 'string' || value.trim() === '') throw this.refusal(ANSWERS.badValue);
    return this.command(id, { mode: value.trim() });
  }

  /** Off: never refused for an option, a read in progress or an unread configuration. */
  async off(id) {
    this.offSeq.set(id, (this.offSeq.get(id) ?? 0) + 1);
    // What was asked before it never leaves after it.
    this.link?.cancel((job) => job.target === id && job.priority !== PRIORITY.OFF);
    this.keepGuard(id);
    if (!this.link && this.memory?.address) {
      this.useAddress(addressOf(this.memory.address), this.memory.address);
    }
    if (!this.link) return this.text(ANSWERS.offWaiting);
    const flow = { sent: false };
    const result = await this.withBudget(this.sendOff(id, { flow }), 'waiting');
    switch (result) {
      case 'confirmed':
        return this.text(ANSWERS.confirmed);
      case 'kept':
        return this.text(ANSWERS.offKept);
      case 'notFound':
        this.dropGuard(id);
        throw this.refusal(ANSWERS.notFound);
      default:
        return this.text(flow.sent ? ANSWERS.offKept : ANSWERS.offWaiting);
    }
  }

  /** Races a promise against the command budget (the ack before Gladys gives up). */
  async withBudget(promise, late) {
    // The loser of the race may still fail later: never an unhandled rejection.
    promise.catch(() => {});
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = this.timers.setTimeout(() => resolve(late), TIMINGS.command);
        }),
      ]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** On (last color), a color, or a mode. */
  async command(id, { color, mode }) {
    const link = this.link;
    if (!link || !this.config) throw this.refusal(ANSWERS.noServer);
    if (mode !== undefined && !this.config.allowModes) throw this.refusal(ANSWERS.modesOff);
    if (this.activeCommands >= LIMITS.commands) throw this.refusal(ANSWERS.busy);
    this.activeCommands += 1;
    try {
      return await this.runCommand(link, id, { color, mode });
    } finally {
      this.activeCommands -= 1;
    }
  }

  async runCommand(link, id, { color, mode }) {
    const seq = this.offSeq.get(id) ?? 0;
    const flow = { sent: false, over: false };
    const beforeSend = () =>
      !flow.over &&
      (this.offSeq.get(id) ?? 0) === seq &&
      link === this.link &&
      (mode === undefined || this.config?.allowModes === true);
    const extra = { target: id, beforeSend };
    const sent = () => {
      // A newer command left: the resends of an older Off stop.
      if (!flow.sent) this.dropGuard(id);
      flow.sent = true;
    };
    const run = async () => {
      const at = await this.locate(link, id, PRIORITY.COMMAND, extra);
      if (!at) throw this.refusal(ANSWERS.notFound);
      const before = stateOf(at.c);
      let check;
      if (mode !== undefined) {
        const target = at.c.modes.find((m) => shortName(m.name) === mode);
        if (!target) throw this.refusal(ANSWERS.unknownMode);
        await link.request((v) => P.updateMode(at.index, target, v), {
          ...extra,
          index: at.index,
          priority: PRIORITY.COMMAND,
          sent,
        });
        check = (c) => shortName(c.modes[c.activeMode]?.name ?? '') === mode;
      } else {
        const wanted = color ?? this.memory?.devices[id]?.color ?? before.color ?? WHITE;
        if (color === undefined && before.on === true) return this.text(ANSWERS.confirmed);
        const opts = { ...extra, index: at.index, priority: PRIORITY.COMMAND, sent };
        await link.request(P.setCustomMode(at.index), opts);
        await link.request(P.updateLeds(at.index, at.c.ledCount, wanted), opts);
        const entry = this.remember(id);
        if (entry && entry.color !== wanted) {
          entry.color = wanted;
          this.save();
        }
        check = (c) => showsColor(c, wanted);
      }
      const after = await this.confirmRead(link, at.index, id, PRIORITY.COMMAND);
      return this.text(after && check(after) ? ANSWERS.confirmed : ANSWERS.unconfirmed);
    };
    let result;
    try {
      result = await this.withBudget(run(), undefined);
    } catch (err) {
      flow.over = true;
      if (err instanceof Refusal) throw err;
      if ((err?.code === 'cancelled' || err?.code === 'cut') && !flow.sent) {
        throw this.refusal(ANSWERS.cancelled);
      }
      if (flow.sent) return this.text(ANSWERS.unconfirmed);
      throw this.refusal(join(STATUS.unreachable, ANSWERS.nothingSent));
    }
    if (result === undefined) {
      // Out of budget: whatever has not left never will.
      flow.over = true;
      if (flow.sent) return this.text(ANSWERS.unconfirmed);
      throw this.refusal(ANSWERS.nothingSent);
    }
    return result;
  }

  async loadProfile(value) {
    const link = this.link;
    if (!link || !this.config) throw this.refusal(ANSWERS.noServer);
    if (!this.config.allowProfiles) throw this.refusal(ANSWERS.profilesOff);
    if (typeof value !== 'string' || value.trim() === '') throw this.refusal(ANSWERS.badValue);
    const name = value.trim();
    const flow = { sent: false, over: false };
    const beforeSend = () =>
      !flow.over && link === this.link && this.config?.allowProfiles === true;
    const run = async () => {
      const profiles = await this.readProfiles(link, PRIORITY.COMMAND, { beforeSend });
      if (!profiles) throw this.refusal(ANSWERS.oldServer);
      const real = profiles.find((p) => shortName(p) === name);
      if (real === undefined) throw this.refusal(ANSWERS.unknownProfile);
      await link.request(P.loadProfile(real), {
        priority: PRIORITY.COMMAND,
        beforeSend,
        sent: () => {
          flow.sent = true;
          // A profile loaded after an Off is a newer choice: the resends stop.
          for (const guard of this.allGuards()) this.dropGuard(guard.id);
        },
      });
      return this.text(ANSWERS.profileSent);
    };
    let result;
    try {
      result = await this.withBudget(run(), undefined);
    } catch (err) {
      flow.over = true;
      if (err instanceof Refusal) throw err;
      if (flow.sent) return this.text(ANSWERS.profileSent);
      throw this.refusal(join(STATUS.unreachable, ANSWERS.nothingSent));
    }
    if (result === undefined) {
      flow.over = true;
      if (flow.sent) return this.text(ANSWERS.profileSent);
      throw this.refusal(ANSWERS.nothingSent);
    }
    return result;
  }

  /** The profile names; undefined when the server is too old for them (protocol < 2). */
  async readProfiles(link, priority, extra) {
    await link.open();
    if (link.version < 2) return undefined;
    const { body } = await link.request(P.requestProfileList(), {
      expect: COMMANDS.REQUEST_PROFILE_LIST,
      priority,
      ...extra,
    });
    try {
      return P.parseProfiles(body).filter((n) => n !== '' && n.length <= LIMITS.profileNameBytes);
    } catch (err) {
      throw new LinkError('protocol', err.message);
    }
  }

  // ---- Discovery, devices, button ------------------------------------------------

  /** Discovery: the controllers of the last read (a read only when the last is older than the interval). */
  async scan() {
    if (!this.link || !this.config) {
      await this.gladys.publishDiscoveredDevices([]);
      return;
    }
    if (this.mayReadNow()) await this.poll();
    const list = this.lastRead?.list;
    const created = new Map();
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseExternalId(device?.external_id, this.gladys.selector);
      if (parsed?.kind === KIND) created.set(parsed.id, device);
    }
    const devices = [];
    for (const [id, { c }] of list?.found ?? []) {
      devices.push(
        buildDevice(this.gladys, c, {
          id,
          language: this.language,
          address: this.link.key,
          created: created.get(id),
        }),
      );
    }
    if (list) {
      let profiles;
      try {
        profiles = await this.readProfiles(this.link, PRIORITY.READ);
      } catch {
        profiles = undefined;
      }
      if (profiles?.length) {
        devices.push(
          buildServerDevice(this.gladys, profiles, {
            language: this.language,
            address: this.link.key,
          }),
        );
      }
    }
    await this.gladys.publishDiscoveredDevices(devices);
  }

  /** A device created: its states at the next read (nothing old published now). */
  async deviceCreated() {}

  async deviceDeleted(device) {
    const parsed = parseExternalId(device?.external_id, this.gladys.selector);
    if (parsed?.kind !== KIND || !this.memory?.devices[parsed.id]) return;
    delete this.memory.devices[parsed.id];
    this.dropGuard(parsed.id);
    this.save();
  }

  /** The button: a read, or the last one when it is younger than the interval. */
  async testConnection() {
    if (!this.config?.address)
      throw this.refusal(this.config?.addressError ? STATUS.badServer : STATUS.noServer);
    const read = this.mayReadNow();
    if (read) await this.poll();
    if (!this.lastRead) {
      if (!read) return this.text(TEST.planned);
      throw new Error(this.text(STATUS.unreachable));
    }
    const message = this.lastStatus ? this.text(this.lastStatus) : this.text(STATUS.unreachable);
    if (this.lastRead.error) throw new Error(message);
    return read ? message : `${this.text(TEST.recent)} ${message}`;
  }

  /**
   * A read now would not come sooner than the interval: after the last read (monotonic), or
   * after a restart, after the last attempt kept in /data (wall clock, the only way across a
   * restart).
   */
  mayReadNow() {
    const interval = this.config.pollInterval * 1000;
    if (this.lastRead) return this.monotonic() - this.lastRead.at >= interval;
    const last = this.memory?.lastAttemptAt;
    return last === undefined || this.now() - last >= interval;
  }
}

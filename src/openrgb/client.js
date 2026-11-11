// -----------------------------------------------------------------------------
// One TCP connection to the OpenRGB SDK server, one request in flight (never a
// pipeline): requests wait in a queue by priority (an Off before a command,
// a command before a read), an answer is taken only when its header carries
// the packet id and device index of the request in flight, a packet nobody
// awaits is dropped (DEVICE_LIST_UPDATED marks the list as changed). Every
// answer is bounded in size (header first: a packet over LIMITS.packetBytes
// closes the connection before its body is read) and in time.
//
// An Off waiting behind a request with no byte for TIMINGS.stall cuts it: the
// socket is destroyed, the request fails as `cut` (not a failure of the
// server), and the next connection opens only once the old one is closed.
// -----------------------------------------------------------------------------

import { Socket } from 'node:net';
import { API, COMMANDS, HEADER_SIZE, LIMITS, TIMINGS } from '../constants.js';
import * as P from './protocol.js';

export const PRIORITY = { OFF: 0, COMMAND: 1, READ: 2 };

export class LinkError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'LinkError';
    this.code = code;
  }
}

/** The real transport: a TCP socket. Tests pass their own (fake server on 127.0.0.1 is enough). */
export const tcpTransport = {
  connect: ({ host, port }) => {
    const socket = new Socket();
    socket.setNoDelay(true);
    socket.connect({ host, port });
    return socket;
  },
};

export class Link {
  constructor({ host, port, transport = tcpTransport, timers, monotonic, onListChanged }) {
    this.host = host;
    this.port = port;
    this.transport = transport;
    this.timers = timers;
    this.monotonic = monotonic;
    this.onListChanged = onListChanged;
    this.queue = [];
    this.socket = undefined;
    this.opening = undefined;
    this.closing = undefined;
    this.inflight = undefined;
    this.version = undefined;
    this.closed = false;
    this.pumping = false;
    this.buffer = Buffer.alloc(0);
    this.lastByteAt = 0;
    this.holds = 0;
  }

  /**
   * Sends a packet (or `(version) => packet`, built with the protocol version of the
   * connection), awaits its answer `{ body, version }` when `expect` names a packet id;
   * `target` tags the job (see cancel). `beforeSend()` runs
   * just before the bytes leave (returns false: nothing sent, `cancelled`); `sent()` right
   * after they are written.
   */
  request(packet, { expect, index = 0, priority = PRIORITY.READ, target, beforeSend, sent } = {}) {
    if (this.closed) return Promise.reject(new LinkError('closed'));
    return new Promise((resolve, reject) => {
      const job = { packet, expect, index, priority, target, beforeSend, sent, resolve, reject };
      let at = this.queue.findIndex((j) => j.priority > priority);
      if (at < 0) at = this.queue.length;
      this.queue.splice(at, 0, job);
      if (priority === PRIORITY.OFF) this.cutStalled();
      this.pump();
    });
  }

  /** Drops the queued jobs `match` selects (not the one in flight): they reject as `cancelled`. */
  cancel(match) {
    const kept = [];
    for (const job of this.queue) {
      if (match(job)) job.reject(new LinkError('cancelled'));
      else kept.push(job);
    }
    this.queue = kept;
  }

  /**
   * Keeps the connection for the Offs until `release()`: between two requests of an Off,
   * nothing else leaves (the next request of the Off is queued a few turns later).
   */
  reserve() {
    this.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      this.pump();
    };
  }

  /** A read with no byte for TIMINGS.stall, while an Off waits: the connection is cut. */
  cutStalled() {
    const job = this.inflight;
    if (!job || job.priority === PRIORITY.OFF) return;
    if (this.monotonic() - this.lastByteAt >= TIMINGS.stall) {
      this.drop(new LinkError('cut', 'cut by an Off'));
    } else {
      job.stallTimer ??= this.timers.setTimeout(() => {
        job.stallTimer = undefined;
        if (this.inflight === job && this.queue.some((j) => j.priority === PRIORITY.OFF)) {
          this.cutStalled();
        }
      }, TIMINGS.stall);
    }
  }

  async pump() {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        try {
          await this.open();
        } catch (err) {
          // Not connected: every job waiting fails the same way.
          for (const job of this.queue.splice(0)) job.reject(err);
          break;
        }
        // Held for an Off: only Offs leave until it is released.
        const at = this.holds > 0 ? this.queue.findIndex((j) => j.priority === PRIORITY.OFF) : 0;
        if (at < 0) break;
        const [job] = this.queue.splice(at, 1);
        await this.run(job);
      }
    } finally {
      this.pumping = false;
    }
  }

  async run(job) {
    if (job.beforeSend && job.beforeSend() === false) {
      job.reject(new LinkError('cancelled'));
      return;
    }
    const socket = this.socket;
    if (!socket) {
      job.reject(new LinkError('closed'));
      return;
    }
    const version = this.version;
    socket.write(typeof job.packet === 'function' ? job.packet(version) : job.packet);
    job.sent?.();
    if (job.expect === undefined) {
      job.resolve(undefined);
      return;
    }
    await new Promise((done) => {
      this.inflight = job;
      this.lastByteAt = this.monotonic();
      const finish = (fn, value) => {
        if (this.inflight !== job) return;
        this.inflight = undefined;
        this.timers.clearTimeout(job.timer);
        if (job.stallTimer) this.timers.clearTimeout(job.stallTimer);
        fn(value);
        done();
      };
      job.finish = finish;
      job.timer = this.timers.setTimeout(() => {
        finish(job.reject, new LinkError('timeout', 'no answer'));
        // The answer may still come: the connection is not reused.
        this.drop(new LinkError('timeout'));
      }, TIMINGS.answer);
      this.consume();
    });
  }

  /** Opens the connection (the old one closed first), agrees on the protocol version. */
  async open() {
    if (this.closed) throw new LinkError('closed');
    if (this.socket) return;
    if (this.closing) await this.closing;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const socket = this.transport.connect({ host: this.host, port: this.port });
      this.buffer = Buffer.alloc(0);
      await new Promise((resolve, reject) => {
        const timer = this.timers.setTimeout(() => {
          socket.destroy();
          reject(new LinkError('unreachable', 'connection timed out'));
        }, TIMINGS.connect);
        socket.once('connect', () => {
          this.timers.clearTimeout(timer);
          resolve();
        });
        socket.once('error', (err) => {
          this.timers.clearTimeout(timer);
          reject(new LinkError('unreachable', err?.code ?? 'connection failed'));
        });
      });
      if (this.closed) {
        socket.destroy();
        throw new LinkError('closed');
      }
      const ended = new Promise((resolve) => socket.once('close', resolve));
      socket.on('error', () => {});
      socket.on('data', (chunk) => this.onData(socket, chunk));
      socket.on('close', () => {
        if (this.socket === socket) this.lost(new LinkError('closed', 'connection closed'));
      });
      this.socket = socket;
      this.ended = ended;
      // The version: an old server (protocol 0) never answers it.
      this.version = 0;
      try {
        const { body } = await this.direct(
          socket,
          P.requestProtocolVersion(API.clientVersion),
          COMMANDS.REQUEST_PROTOCOL_VERSION,
        );
        this.version = Math.min(P.parseUint32(body), API.clientVersion);
      } catch (err) {
        if (err?.code !== 'timeout') throw err;
        if (this.socket !== socket) throw new LinkError('closed');
      }
      socket.write(P.setClientName(API.clientName));
    })();
    try {
      await this.opening;
    } catch (err) {
      this.drop(err);
      throw err;
    } finally {
      this.opening = undefined;
    }
  }

  /** A request while opening (outside the queue). A timeout here does not drop the socket. */
  direct(socket, packet, expect) {
    return new Promise((resolve, reject) => {
      const job = { expect, index: 0, priority: PRIORITY.OFF };
      this.inflight = job;
      this.lastByteAt = this.monotonic();
      job.finish = (fn, value) => {
        if (this.inflight !== job) return;
        this.inflight = undefined;
        this.timers.clearTimeout(job.timer);
        fn(value);
      };
      job.resolve = resolve;
      job.reject = reject;
      job.timer = this.timers.setTimeout(
        () => job.finish(reject, new LinkError('timeout', 'no answer')),
        TIMINGS.answer,
      );
      socket.write(packet);
      this.consume();
    });
  }

  onData(socket, chunk) {
    if (this.socket !== socket) return;
    this.lastByteAt = this.monotonic();
    if (this.buffer.length + chunk.length > LIMITS.bufferedBytes) {
      this.drop(new LinkError('protocol', 'too much data'));
      return;
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.consume();
  }

  /** Whole packets out of the buffer, checked header first. */
  consume() {
    for (;;) {
      let header;
      try {
        header = P.decodeHeader(this.buffer);
      } catch (err) {
        this.drop(new LinkError('protocol', err.message));
        return;
      }
      if (!header || this.buffer.length < HEADER_SIZE + header.length) return;
      const body = this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + header.length);
      this.buffer = this.buffer.subarray(HEADER_SIZE + header.length);
      if (header.command === COMMANDS.DEVICE_LIST_UPDATED) {
        this.onListChanged?.();
        continue;
      }
      const job = this.inflight;
      if (job && job.expect === header.command && job.index === header.index) {
        job.finish(job.resolve, { body: Buffer.from(body), version: this.version });
      }
      // Anything else: not the answer to our request, dropped.
    }
  }

  /** The connection is gone: the request in flight fails, the queue stays for the next one. */
  lost(err) {
    const job = this.inflight;
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
    if (job) job.finish(job.reject, err);
  }

  /** Destroys the connection now; the next request opens a new one after the close. */
  drop(err) {
    const socket = this.socket;
    if (!socket) {
      if (this.inflight) this.lost(err);
      return;
    }
    const ended = this.ended;
    this.lost(err);
    let timer;
    this.closing = Promise.race([
      ended,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(resolve, TIMINGS.connect);
      }),
    ]).then(() => {
      this.timers.clearTimeout(timer);
      this.closing = undefined;
    });
    socket.destroy();
  }

  /** For good: everything waiting fails, no new connection. */
  close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new LinkError('closed'));
    this.drop(new LinkError('closed'));
  }
}

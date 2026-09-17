import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { Logger } from 'pino';
import type { Adapters } from '@confluo/adapters';
import {
  CLOSE_FORBIDDEN,
  CLOSE_KICKED,
  CLOSE_NOT_FOUND,
  CLOSE_RATE_LIMITED,
  CLOSE_SERVER_SHUTDOWN,
  MAX_FRAME_BYTES,
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_RPC,
  MESSAGE_SYNC,
  RoleRank,
  RpcRequestSchema,
  SYNC_STEP1,
  TICKET_TTL_SECONDS,
  TicketPayloadSchema,
  newClientId,
  type Role,
  type ServerEventType,
} from '@confluo/shared';
import { Metrics } from './metrics.js';
import { Connection } from './ws/connection.js';
import { gate, mustStripLock } from './ws/gate.js';
import {
  busDataToString,
  decodeBusFrame,
  encodeAwareness,
  encodeAwarenessRaw,
  encodeBusFrame,
  encodeSyncStep1,
  encodeUpdate,
  inspectAwarenessUpdate,
} from './ws/codec.js';
import { Persistence } from './sync/persistence.js';
import { DocManager, DocNotFoundError } from './sync/doc-manager.js';
import type { Room } from './sync/room.js';
import { LockService } from './locks/lock-service.js';
import { handleRpc, type RpcContext } from './rpc/handlers.js';

export interface SyncConfig {
  nodeId: string;
  webUrl: string;
  /** '' when standalone, '/sync' when mounted inside the all-in-one server. */
  pathPrefix: string;
  maxRssMb: number;
}

export interface SyncDeps {
  adapters: Adapters;
  config: SyncConfig;
  logger: Logger;
}

export interface SyncServer {
  /** Returns true when the URL matched `${pathPrefix}/v1/docs/{docId}` and the upgrade was handled. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  metrics(): Promise<string>;
  stats(): { rooms: number; connections: number };
  close(): Promise<void>;
}

const MAX_SOCKETS_PER_USER_PER_DOC = 20;
const PING_INTERVAL_MS = 30_000;
const LOCK_SWEEP_MS = 5_000;
const COMPACT_CHECK_MS = 30_000;
const EVICT_CHECK_MS = 10_000;
const FORBIDDEN_EDIT_NOTICE_MS = 10_000;

interface BusEvent {
  type: ServerEventType | 'kick';
  payload: unknown;
  ts: number;
  origin?: string;
}

function rawToU8(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    const b = Buffer.concat(data);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export class SyncCore implements SyncServer {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private readonly metricsReg = new Metrics();
  private readonly persistence: Persistence;
  private readonly docManager: DocManager;
  private readonly locks: LockService;
  private readonly rpcCtx: RpcContext;
  private readonly urlRe: RegExp;
  private readonly timers: NodeJS.Timeout[] = [];
  private closing = false;
  private readonly logger: Logger;
  private readonly nodeId: string;

  constructor(private readonly deps: SyncDeps) {
    const { adapters, config, logger } = deps;
    this.logger = logger.child({ component: 'sync', nodeId: config.nodeId });
    this.nodeId = config.nodeId;
    this.urlRe = new RegExp(`^${escapeRe(config.pathPrefix)}/v1/docs/([0-9a-fA-F-]{36})/?$`);
    this.persistence = new Persistence(adapters.db, adapters.kv, config.nodeId, this.metricsReg, this.logger);
    this.locks = new LockService(adapters.kv, (docId, change) =>
      this.publishEvent(docId, 'lock.changed', change),
    );
    this.docManager = new DocManager({
      db: adapters.db,
      persistence: this.persistence,
      metrics: this.metricsReg,
      logger: this.logger,
      maxRssMb: config.maxRssMb,
      onRoomLoaded: (room) => this.attachRoom(room),
    });
    this.rpcCtx = {
      locks: this.locks,
      metrics: this.metricsReg,
      nodeId: config.nodeId,
      publishEvent: (docId, type, payload) => this.publishEvent(docId, type, payload),
    };
  }

  start(): void {
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(PING_INTERVAL_MS, () => this.pingAll());
    every(LOCK_SWEEP_MS, () => {
      for (const room of this.docManager.rooms.values()) void this.locks.sweep(room).catch(() => undefined);
    });
    every(COMPACT_CHECK_MS, () => {
      for (const room of this.docManager.rooms.values()) {
        void room.maybeCompact().catch((err) => this.logger.warn({ err, docId: room.docId }, 'compaction failed'));
        this.metricsReg.setDocStateBytes(room.docId, room.stateBytes());
      }
    });
    every(EVICT_CHECK_MS, () => this.docManager.evictIfNeeded());
  }

  // ---- public surface -------------------------------------------------------

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return false;
    }
    const m = url.pathname.match(this.urlRe);
    if (!m) return false;
    void this.doUpgrade(req, socket, head, m[1]!, url.searchParams.get('ticket'));
    return true;
  }

  metrics(): Promise<string> {
    return this.metricsReg.text();
  }

  stats() {
    let connections = 0;
    for (const r of this.docManager.rooms.values()) connections += r.connections.size;
    return { rooms: this.docManager.rooms.size, connections };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const t of this.timers) clearInterval(t);
    for (const room of this.docManager.rooms.values()) {
      for (const c of [...room.connections]) c.close(CLOSE_SERVER_SHUTDOWN, 'server shutting down');
    }
    await this.docManager.closeAll(10_000);
    await new Promise<void>((res) => this.wss.close(() => res()));
  }

  // ---- upgrade -----------------------------------------------------------------

  private reject(socket: Duplex, status: number, text: string) {
    try {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch {
      /* ignore */
    }
    socket.destroy();
  }

  private async doUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    docId: string,
    ticket: string | null,
  ): Promise<void> {
    const { adapters, config } = this.deps;
    if (this.closing) return this.reject(socket, 503, 'Service Unavailable');
    const origin = req.headers.origin;
    if (origin && origin !== config.webUrl) return this.reject(socket, 403, 'Forbidden');
    if (!ticket) return this.reject(socket, 401, 'Unauthorized');

    let raw: string | null = null;
    try {
      raw = await adapters.kv.getdel(`ticket:${ticket}`);
    } catch (err) {
      this.logger.error({ err }, 'ticket lookup failed');
      return this.reject(socket, 503, 'Service Unavailable');
    }
    if (!raw) return this.reject(socket, 401, 'Unauthorized');
    let payload;
    try {
      payload = TicketPayloadSchema.parse(JSON.parse(raw));
    } catch {
      return this.reject(socket, 401, 'Unauthorized');
    }
    if (Date.now() - payload.iat > TICKET_TTL_SECONDS * 1000) return this.reject(socket, 401, 'Unauthorized');
    if (payload.docId !== docId) return this.reject(socket, 403, 'Forbidden');

    let room: Room;
    try {
      room = await this.docManager.get(docId);
    } catch (err) {
      if (err instanceof DocNotFoundError) return this.reject(socket, 404, 'Not Found');
      this.logger.error({ err, docId }, 'room load failed');
      return this.reject(socket, 500, 'Internal Server Error');
    }
    if (room.connectionsOf(payload.userId).length >= MAX_SOCKETS_PER_USER_PER_DOC) {
      return this.reject(socket, 429, 'Too Many Requests');
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws, room, {
        userId: payload.userId,
        docId,
        role: payload.role,
        name: payload.name,
        color: payload.color,
        clientId: newClientId(),
      });
    });
  }

  // ---- connection lifecycle -------------------------------------------------------

  private onConnection(
    ws: WebSocket,
    room: Room,
    identity: { userId: string; docId: string; role: Role; name: string; color: string; clientId: string },
  ) {
    const conn = new Connection(ws, room, identity);
    room.connections.add(conn);
    room.lastActivityAt = Date.now();
    this.docManager.cancelUnload(room);
    this.metricsReg.connections.inc({ role: conn.role });
    this.logger.debug({ docId: room.docId, userId: conn.userId, role: conn.role, connId: conn.clientId }, 'open');

    ws.on('pong', () => {
      conn.isAlive = true;
    });
    ws.on('message', (data, isBinary) => this.onMessage(conn, data, isBinary));
    ws.on('close', () => void this.onClose(conn));
    ws.on('error', (err) => {
      this.logger.debug({ err, connId: conn.clientId }, 'socket error');
      conn.close(1011, 'socket error');
    });

    conn.send(encodeSyncStep1(room.ydoc));
    const states = room.awareness.getStates();
    if (states.size > 0) conn.send(encodeAwareness(room.awareness, [...states.keys()]), { awareness: true });
    conn.sendEvent('connected', { clientId: conn.clientId, role: conn.role, nodeId: this.nodeId });
    void this.locks
      .list(room.docId)
      .then((list) => {
        for (const { blockId, ...holder } of list) {
          conn.sendEvent('lock.changed', { blockId, holder, expiresAt: holder.expiresAt });
        }
      })
      .catch(() => undefined);
  }

  private async onClose(conn: Connection) {
    const room = conn.room;
    if (!room.connections.has(conn)) return;
    conn.closed = true;
    room.connections.delete(conn);
    this.metricsReg.connections.dec({ role: conn.role });
    if (conn.awarenessClientIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(room.awareness, [...conn.awarenessClientIds], null);
    }
    await this.locks.releaseAll(room, conn).catch((err) => this.logger.warn({ err }, 'releaseAll failed'));
    if (room.connections.size === 0) this.docManager.scheduleUnload(room);
  }

  private pingAll() {
    for (const room of this.docManager.rooms.values()) {
      for (const c of room.connections) {
        if (!c.isAlive) {
          c.socket.terminate();
          continue;
        }
        c.isAlive = false;
        try {
          c.socket.ping();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ---- inbound frames -------------------------------------------------------------

  private forbiddenEdit(conn: Connection) {
    const now = Date.now();
    if (now - conn.lastForbiddenEditAt < FORBIDDEN_EDIT_NOTICE_MS) return;
    conn.lastForbiddenEditAt = now;
    conn.sendEvent('error', { code: 'FORBIDDEN_EDIT', message: 'Your role does not allow editing this document' });
  }

  private onMessage(conn: Connection, data: RawData, isBinary: boolean) {
    if (!isBinary || conn.closed) return;
    if (!conn.takeToken()) {
      conn.close(CLOSE_RATE_LIMITED, 'rate limited');
      return;
    }
    const room = conn.room;
    room.lastActivityAt = Date.now();
    let decoder: decoding.Decoder;
    let type: number;
    try {
      decoder = decoding.createDecoder(rawToU8(data));
      type = decoding.readVarUint(decoder);
    } catch {
      return;
    }
    try {
      switch (type) {
        case MESSAGE_SYNC: {
          const sub = decoding.readVarUint(decoder);
          const decision = gate(conn.role, MESSAGE_SYNC, sub);
          if (decision !== 'allow') {
            this.metricsReg.gateDropped.inc({ role: conn.role, type: `sync:${sub}` });
            if (sub !== SYNC_STEP1) this.forbiddenEdit(conn);
            return;
          }
          if (sub === SYNC_STEP1) {
            const enc = encoding.createEncoder();
            encoding.writeVarUint(enc, MESSAGE_SYNC);
            syncProtocol.readSyncStep1(decoder, enc, room.ydoc);
            conn.send(encoding.toUint8Array(enc));
          } else {
            const update = decoding.readVarUint8Array(decoder);
            this.metricsReg.updateBytes.inc(update.byteLength);
            Y.applyUpdate(room.ydoc, update, conn);
          }
          return;
        }
        case MESSAGE_AWARENESS: {
          if (gate(conn.role, MESSAGE_AWARENESS) !== 'allow') return;
          const raw = decoding.readVarUint8Array(decoder);
          const { clientIds, update } = inspectAwarenessUpdate(raw, mustStripLock(conn.role));
          for (const id of clientIds) conn.awarenessClientIds.add(id);
          awarenessProtocol.applyAwarenessUpdate(room.awareness, update, conn);
          this.metricsReg.awarenessUpdates.inc();
          return;
        }
        case MESSAGE_QUERY_AWARENESS: {
          if (gate(conn.role, MESSAGE_QUERY_AWARENESS) !== 'allow') return;
          conn.send(encodeAwareness(room.awareness, [...room.awareness.getStates().keys()]), { awareness: true });
          return;
        }
        case MESSAGE_RPC: {
          let json: unknown;
          let id = 'unknown';
          try {
            json = JSON.parse(decoding.readVarString(decoder));
            if (json && typeof json === 'object' && typeof (json as { id?: unknown }).id === 'string') {
              id = (json as { id: string }).id;
            }
          } catch {
            conn.sendRpcResult({ id, ok: false, error: { code: 'VALIDATION_FAILED', message: 'invalid JSON' } });
            return;
          }
          const parsed = RpcRequestSchema.safeParse(json);
          if (!parsed.success) {
            conn.sendRpcResult({ id, ok: false, error: { code: 'VALIDATION_FAILED', message: parsed.error.message } });
            return;
          }
          const req = parsed.data;
          const decision = gate(conn.role, MESSAGE_RPC, req.method);
          if (decision !== 'allow') {
            this.metricsReg.gateDropped.inc({ role: conn.role, type: `rpc:${req.method}` });
            conn.sendRpcResult({ id: req.id, ok: false, error: { code: 'FORBIDDEN', message: 'not allowed for your role' } });
            return;
          }
          void handleRpc(this.rpcCtx, conn, req).then((res) => conn.sendRpcResult(res));
          return;
        }
        default:
          this.metricsReg.gateDropped.inc({ role: conn.role, type: `unknown:${type}` });
      }
    } catch (err) {
      this.logger.warn({ err, connId: conn.clientId, type }, 'failed to handle frame');
    }
  }

  // ---- room wiring & bus -------------------------------------------------------------

  private async attachRoom(room: Room): Promise<void> {
    const { pubsub } = this.deps.adapters;
    const docId = room.docId;

    room.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      const frame = encodeUpdate(update);
      for (const c of room.connections) if (c !== origin) c.send(frame);
      if (origin instanceof Connection) {
        void pubsub
          .publish(`doc:${docId}:updates`, encodeBusFrame(this.nodeId, update))
          .catch((err) => this.logger.warn({ err, docId }, 'bus_unavailable (updates)'));
        room.enqueue(update, origin.userId);
      }
    });

    room.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = added.concat(updated, removed);
        if (changed.length === 0) return;
        const update = awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed);
        const frame = encodeAwarenessRaw(update);
        for (const c of room.connections) c.send(frame, { awareness: true });
        if (origin !== 'redis') {
          void pubsub
            .publish(`doc:${docId}:awareness`, encodeBusFrame(this.nodeId, update))
            .catch((err) => this.logger.warn({ err, docId }, 'bus_unavailable (awareness)'));
        }
      },
    );

    room.unsubscribers.push(
      await pubsub.subscribe(`doc:${docId}:updates`, (data) => {
        const f = decodeBusFrame(data);
        if (!f || f.nodeId === this.nodeId) return;
        try {
          Y.applyUpdate(room.ydoc, f.bytes, 'redis');
        } catch (err) {
          this.logger.warn({ err, docId }, 'bad bus update');
        }
      }),
      await pubsub.subscribe(`doc:${docId}:awareness`, (data) => {
        const f = decodeBusFrame(data);
        if (!f || f.nodeId === this.nodeId) return;
        try {
          awarenessProtocol.applyAwarenessUpdate(room.awareness, f.bytes, 'redis');
        } catch {
          /* ignore */
        }
      }),
      await pubsub.subscribe(`doc:${docId}:events`, (data) => {
        let evt: BusEvent;
        try {
          evt = JSON.parse(busDataToString(data)) as BusEvent;
        } catch {
          return;
        }
        void this.onBusEvent(room, evt).catch((err) => this.logger.warn({ err, docId, type: evt.type }, 'event failed'));
      }),
    );
  }

  private async publishEvent(docId: string, type: ServerEventType | 'kick', payload: unknown): Promise<void> {
    const evt: BusEvent = { type, payload, ts: Date.now(), origin: this.nodeId };
    try {
      await this.deps.adapters.pubsub.publish(`doc:${docId}:events`, JSON.stringify(evt));
    } catch (err) {
      // Bus down: degrade to local fan-out so single-node operation keeps working.
      this.logger.warn({ err, docId }, 'bus_unavailable (events); local fan-out');
      const room = this.docManager.rooms.get(docId);
      if (room) await this.onBusEvent(room, evt);
    }
  }

  private fanout(room: Room, evt: BusEvent) {
    const wire = { type: evt.type as ServerEventType, payload: evt.payload, ts: evt.ts };
    for (const c of room.connections) c.sendRawEvent(wire);
  }

  private async onBusEvent(room: Room, evt: BusEvent): Promise<void> {
    switch (evt.type) {
      case 'permission.changed': {
        const p = evt.payload as { userId: string; role: Role | null };
        for (const c of room.connectionsOf(p.userId)) {
          if (!p.role) {
            c.sendEvent('role.changed', { role: null });
            await this.locks.releaseAll(room, c, { handover: false });
            c.close(CLOSE_FORBIDDEN, 'access revoked');
            continue;
          }
          const old = c.role;
          if (old === p.role) continue;
          this.metricsReg.connections.dec({ role: old });
          c.role = p.role;
          this.metricsReg.connections.inc({ role: c.role });
          if (RoleRank[p.role] < RoleRank.editor && RoleRank[old] >= RoleRank.editor) {
            await this.locks.releaseAll(room, c, { handover: false });
          }
          c.sendEvent('role.changed', { role: p.role });
        }
        this.fanout(room, evt);
        return;
      }
      case 'doc.deleted': {
        this.fanout(room, evt);
        for (const c of [...room.connections]) c.close(CLOSE_NOT_FOUND, 'document deleted');
        await this.docManager.unload(room, 'deleted', { discard: true });
        return;
      }
      case 'kick': {
        const p = evt.payload as { userId: string };
        for (const c of room.connectionsOf(p.userId)) {
          c.sendEvent('kicked', { reason: 'removed by owner' });
          c.close(CLOSE_KICKED, 'kicked');
        }
        return;
      }
      default:
        this.fanout(room, evt);
    }
  }
}

export async function createSyncServer(deps: SyncDeps): Promise<SyncServer> {
  const core = new SyncCore(deps);
  core.start();
  return core;
}

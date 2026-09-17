import type { WebSocket } from 'ws';
import type { Role, RpcResult, ServerEvent, ServerEventType } from '@confluo/shared';
import { encodeRpcResult, encodeServerEvent, makeEvent } from './codec.js';
import type { Room } from '../sync/room.js';

const AWARENESS_SKIP_BUFFERED = 4 * 1024 * 1024;
const CLOSE_BUFFERED = 16 * 1024 * 1024;
const RATE_PER_SEC = 200;
const RATE_BURST = 400;

export interface ConnectionIdentity {
  userId: string;
  docId: string;
  role: Role;
  name: string;
  color: string;
  clientId: string;
}

/** One WebSocket bound to a room. */
export class Connection {
  readonly userId: string;
  readonly docId: string;
  readonly name: string;
  readonly color: string;
  readonly clientId: string;
  role: Role;
  /** Awareness clientIDs (Yjs numeric ids) this socket has published. */
  readonly awarenessClientIds = new Set<number>();
  /** Block ids currently held under this connection's clientId. */
  readonly locks = new Set<string>();
  isAlive = true;
  lastForbiddenEditAt = 0;
  closed = false;
  private tokens = RATE_BURST;
  private lastRefill = Date.now();

  constructor(
    readonly socket: WebSocket,
    readonly room: Room,
    identity: ConnectionIdentity,
  ) {
    this.userId = identity.userId;
    this.docId = identity.docId;
    this.role = identity.role;
    this.name = identity.name;
    this.color = identity.color;
    this.clientId = identity.clientId;
  }

  /** Token bucket: 200 msg/s sustained, burst 400. Returns false when exhausted. */
  takeToken(): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(RATE_BURST, this.tokens + elapsed * RATE_PER_SEC);
      this.lastRefill = now;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  send(buf: Uint8Array, opts?: { awareness?: boolean }): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    const buffered = this.socket.bufferedAmount;
    if (buffered > CLOSE_BUFFERED) {
      this.close(1013, 'backpressure');
      return;
    }
    if (opts?.awareness && buffered > AWARENESS_SKIP_BUFFERED) return;
    this.socket.send(buf, { binary: true }, (err) => {
      if (err) this.close(1011, 'send failed');
    });
  }

  sendEvent<T>(type: ServerEventType, payload: T): void {
    this.send(encodeServerEvent(makeEvent(type, payload)));
  }

  sendRawEvent(evt: ServerEvent): void {
    this.send(encodeServerEvent(evt));
  }

  sendRpcResult(result: RpcResult): void {
    this.send(encodeRpcResult(result));
  }

  close(code: number, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close(code, reason);
    } catch {
      try {
        this.socket.terminate();
      } catch {
        /* ignore */
      }
    }
  }
}

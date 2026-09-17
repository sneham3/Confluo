import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import {
  CLOSE_FORBIDDEN,
  CLOSE_KICKED,
  CLOSE_NOT_FOUND,
  CLOSE_UNAUTHENTICATED,
  MESSAGE_RPC,
  MESSAGE_RPC_RESULT,
  MESSAGE_SERVER_EVENT,
  NON_RECONNECTABLE_CLOSE_CODES,
  type RpcResult,
} from '@confluo/shared';
import type { ConnectionLogEntry, ConnectionState, DeniedReason, ServerEvent, TicketResponse } from './types';
import { isApiError } from './types';

export interface TicketedProviderOptions {
  docId: string;
  ydoc: Y.Doc;
  awareness: Awareness;
  syncUrl: string;
  getTicket: () => Promise<TicketResponse>;
  onStateChange: (state: ConnectionState, denied?: DeniedReason) => void;
  onEvent: (e: ServerEvent) => void;
  onLog: (e: ConnectionLogEntry) => void;
  onSynced: () => void;
}

type MessageHandler = (
  encoder: encoding.Encoder,
  decoder: decoding.Decoder,
  provider: WebsocketProvider,
  emitSynced: boolean,
  messageType: number,
) => void;

const RECONNECT_MIN_MS = 100;
const RECONNECT_MAX_MS = 10_000;
const OFFLINE_AFTER_MS = 10_000;
const RPC_TIMEOUT_MS = 10_000;

function mapDenied(code: number): DeniedReason {
  switch (code) {
    case CLOSE_UNAUTHENTICATED:
      return 'unauthenticated';
    case CLOSE_FORBIDDEN:
      return 'revoked';
    case CLOSE_NOT_FOUND:
      return 'deleted';
    case CLOSE_KICKED:
      return 'kicked';
    default:
      return 'revoked';
  }
}

/**
 * y-websocket provider wrapper that mints a fresh single-use ticket on every (re)connect,
 * owns the reconnect loop (backoff 100 ms → 10 s + jitter) and speaks the custom RPC /
 * server-event message types (common doc §8.3).
 */
export class TicketedWebsocketProvider {
  readonly provider: WebsocketProvider;
  readonly awareness: Awareness;
  state: ConnectionState = 'connecting';
  deniedReason?: DeniedReason;
  private everConnected = false;
  private attempts = 0;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  private rpcSeq = 0;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly onlineHandler = () => {
    this.log('info', 'Browser is online again');
    // Some browsers keep an established socket alive through a short offline blip. If it is still
    // open and in sync there is nothing to reconnect; just leave the offline state.
    if (this.open && this.provider.synced && this.state !== 'denied') {
      this.clearOfflineTimer();
      this.setState('connected');
      return;
    }
    this.reconnectNow();
  };
  private readonly offlineHandler = () => {
    this.log('warn', 'Browser went offline');
    this.setState('offline');
  };

  constructor(private readonly opts: TicketedProviderOptions) {
    this.awareness = opts.awareness;
    this.provider = new WebsocketProvider(`${trimSlash(opts.syncUrl)}/v1/docs`, opts.docId, opts.ydoc, {
      connect: false,
      awareness: opts.awareness,
      params: {},
      maxBackoffTime: RECONNECT_MAX_MS,
    });
    const handlers = this.provider.messageHandlers as unknown as MessageHandler[];
    handlers[MESSAGE_RPC_RESULT] = (_enc, decoder) => {
      this.handleRpcResult(decoding.readVarString(decoder));
    };
    handlers[MESSAGE_SERVER_EVENT] = (_enc, decoder) => {
      this.handleServerEvent(decoding.readVarString(decoder));
    };

    this.provider.on('status', ({ status }) => {
      if (status === 'connected') {
        this.log('info', 'Socket connected');
      } else if (status === 'connecting') {
        this.log('info', 'Connecting…');
      } else if (status === 'disconnected') {
        this.log('warn', 'Socket disconnected');
      }
    });
    this.provider.on('sync', (synced) => {
      if (synced) {
        this.attempts = 0;
        this.everConnected = true;
        this.clearOfflineTimer();
        this.setState('connected');
        this.log('info', 'Document synced with server');
        opts.onSynced();
      }
    });
    this.provider.on('connection-close', (event) => {
      // Never let y-websocket reconnect by itself: the ticket in `params` is spent.
      this.provider.shouldConnect = false;
      this.rejectAllRpc(new Error('Connection closed'));
      if (this.destroyed) return;
      if (event && NON_RECONNECTABLE_CLOSE_CODES.has(event.code)) {
        this.deny(mapDenied(event.code), `Server closed the connection (${event.code} ${event.reason || ''})`);
        return;
      }
      this.log('warn', `Connection lost${event ? ` (${event.code})` : ''}; will retry`);
      this.scheduleReconnect();
    });
    this.provider.on('connection-error', () => {
      this.log('warn', 'Socket error');
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onlineHandler);
      window.addEventListener('offline', this.offlineHandler);
    }
  }

  get synced(): boolean {
    return this.provider.synced;
  }

  get connected(): boolean {
    return this.provider.wsconnected;
  }

  get open(): boolean {
    const ws = this.provider.ws as WebSocket | null;
    return !!ws && ws.readyState === 1;
  }

  connect(): void {
    if (this.destroyed) return;
    void this.attempt();
  }

  /** Force an immediate reconnect attempt (e.g. browser came back online). */
  reconnectNow(): void {
    if (this.destroyed || this.state === 'denied') return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.provider.ws) {
      // Drop the stale socket; connection-close will schedule the next attempt.
      this.provider.shouldConnect = false;
      (this.provider.ws as WebSocket).close();
      return;
    }
    this.attempts = 0;
    void this.attempt();
  }

  private async attempt(): Promise<void> {
    if (this.destroyed || this.connecting || this.state === 'denied') return;
    if (this.provider.ws) return;
    this.connecting = true;
    if (this.state !== 'offline') this.setState(this.everConnected ? 'reconnecting' : 'connecting');
    this.armOfflineTimer();
    try {
      const ticket = await this.opts.getTicket();
      if (this.destroyed) return;
      const serverUrl = `${trimSlash(ticket.wsUrl || this.opts.syncUrl)}/v1/docs`;
      if (this.provider.serverUrl !== serverUrl) {
        this.provider.serverUrl = serverUrl;
        this.provider.bcChannel = `${serverUrl}/${this.opts.docId}`;
      }
      this.provider.params = { ticket: ticket.ticket };
      this.provider.connect();
    } catch (e) {
      if (this.destroyed) return;
      if (isApiError(e) && (e.status === 401 || e.status === 403 || e.status === 404)) {
        this.deny(e.status === 401 ? 'unauthenticated' : e.status === 404 ? 'deleted' : 'revoked', `Ticket refused (${e.status})`);
        return;
      }
      this.log('warn', `Could not get a socket ticket: ${(e as Error).message}`);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.state === 'denied' || this.reconnectTimer) return;
    if (this.state === 'connected') this.setState('reconnecting');
    this.armOfflineTimer();
    const base = Math.min(RECONNECT_MIN_MS * 2 ** this.attempts, RECONNECT_MAX_MS);
    const delay = base + Math.floor(Math.random() * 250);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attempt();
    }, delay);
  }

  private armOfflineTimer(): void {
    if (this.offlineTimer || this.state === 'connected') return;
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      if (this.state === 'reconnecting' || this.state === 'connecting') this.setState('offline');
    }, OFFLINE_AFTER_MS);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) this.setState('offline');
  }

  private clearOfflineTimer(): void {
    if (this.offlineTimer) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
    }
  }

  private deny(reason: DeniedReason, message: string): void {
    this.deniedReason = reason;
    this.log('error', message);
    this.setState('denied', reason);
    this.provider.shouldConnect = false;
  }

  private setState(state: ConnectionState, denied?: DeniedReason): void {
    if (this.state === state && denied === this.deniedReason) return;
    this.state = state;
    this.opts.onStateChange(state, denied ?? this.deniedReason);
  }

  private log(level: ConnectionLogEntry['level'], message: string): void {
    this.opts.onLog({ ts: Date.now(), level, message });
  }

  // ---- RPC ------------------------------------------------------------------

  rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.open) {
        reject(new Error('Not connected'));
        return;
      }
      const id = `${Date.now().toString(36)}-${(++this.rpcSeq).toString(36)}`;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_RPC);
      encoding.writeVarString(encoder, JSON.stringify({ id, method, params }));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} timed out`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        (this.provider.ws as WebSocket).send(encoding.toUint8Array(encoder));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private handleRpcResult(json: string): void {
    let msg: RpcResult;
    try {
      msg = JSON.parse(json) as RpcResult;
    } catch {
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else {
      const err = new Error(msg.error.message) as Error & { code?: string };
      err.code = msg.error.code;
      p.reject(err);
    }
  }

  private rejectAllRpc(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private handleServerEvent(json: string): void {
    let ev: ServerEvent;
    try {
      ev = JSON.parse(json) as ServerEvent;
    } catch {
      return;
    }
    if (ev.type === 'error') {
      const payload = ev.payload as { code?: string; message?: string };
      this.log('warn', `Server: ${payload.code ?? 'error'} ${payload.message ?? ''}`.trim());
    }
    this.opts.onEvent(ev);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearOfflineTimer();
    this.rejectAllRpc(new Error('Provider destroyed'));
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler);
      window.removeEventListener('offline', this.offlineHandler);
    }
    this.provider.destroy();
  }
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

import type { Editor } from '@tiptap/core';
import type { Role, ServerEvent as SharedServerEvent, LockHolder as SharedLockHolder } from '@confluo/shared';

export type ServerEvent<T = unknown> = SharedServerEvent<T>;
export type LockHolder = SharedLockHolder;

export interface RequestInitLite {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  keepalive?: boolean;
}

/** Minimal HTTP client the package receives; it never hardcodes fetch. Must throw `ApiError` on non-2xx. */
export interface ApiClient {
  get<T = unknown>(path: string, init?: RequestInitLite): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, init?: RequestInitLite): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown, init?: RequestInitLite): Promise<T>;
  delete<T = unknown>(path: string, init?: RequestInitLite): Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError || (typeof e === 'object' && e !== null && 'status' in e && 'code' in e);
}

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'denied';
export type DeniedReason = 'unauthenticated' | 'revoked' | 'deleted' | 'kicked';

export interface ConnectionLogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface CollabUser {
  id: string;
  name: string;
  color: string;
  avatarUrl?: string;
}

export interface Peer {
  clientId: number;
  user: CollabUser;
  role: Role;
  status: 'active' | 'idle';
  lock: { blockId: string; expiresAt: number } | null;
  hasCursor: boolean;
}

export interface TicketResponse {
  ticket: string;
  wsUrl: string;
  role: Role;
  expiresAt: string;
}

export interface CommentAnchor {
  anchorFrom: string;
  anchorTo: string;
  blockId: string;
}

export interface CollabDocOptions {
  docId: string;
  user: CollabUser;
  role: Role;
  api: ApiClient;
  getTicket: () => Promise<TicketResponse>;
  syncUrl: string;
  /** Initial document metadata for the title SaveController. */
  title?: { value: string; version: number };
  onEvent?: (e: ServerEvent) => void;
  onBlocked?: (holder: LockHolder) => void;
  onTitleAdopted?: (doc: { title: string; version: number }) => void;
}

export interface CollabSnapshot {
  editor: Editor | null;
  ready: boolean;
  connectionState: ConnectionState;
  deniedReason?: DeniedReason;
  unsyncedChanges: boolean;
  peers: Peer[];
  locks: Map<string, LockHolder>;
  role: Role;
  log: ConnectionLogEntry[];
  uploadsPending: number;
  uploadProgress: Map<string, number>;
  titleState: 'idle' | 'pending' | 'saving' | 'error';
  title: string;
}

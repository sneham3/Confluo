import { z } from 'zod';
import { RoleSchema } from './roles';

/** WebSocket message types (first varUint of every binary frame). Common doc §8.3 */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_AUTH = 2; // reserved (y-websocket compatibility)
export const MESSAGE_QUERY_AWARENESS = 3;
export const MESSAGE_RPC = 10;
export const MESSAGE_RPC_RESULT = 11;
export const MESSAGE_SERVER_EVENT = 12;

/** y-protocols sync sub-types */
export const SYNC_STEP1 = 0;
export const SYNC_STEP2 = 1;
export const SYNC_UPDATE = 2;

/** Close codes. Common doc §8.6 */
export const CLOSE_NORMAL = 1000;
export const CLOSE_TOO_LARGE = 1009;
export const CLOSE_TRY_AGAIN_LATER = 1013;
export const CLOSE_UNAUTHENTICATED = 4001;
export const CLOSE_FORBIDDEN = 4003;
export const CLOSE_NOT_FOUND = 4004;
export const CLOSE_SERVER_SHUTDOWN = 4008;
export const CLOSE_RATE_LIMITED = 4029;
export const CLOSE_KICKED = 4030;

export const NON_RECONNECTABLE_CLOSE_CODES = new Set([
  CLOSE_UNAUTHENTICATED,
  CLOSE_FORBIDDEN,
  CLOSE_NOT_FOUND,
  CLOSE_KICKED,
]);

export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const TICKET_TTL_SECONDS = 60;
export const LOCK_TTL_MS = 30_000;
export const LOCK_HEARTBEAT_MS = 10_000;
export const AWARENESS_THROTTLE_MS = 33;

/** Yjs field name for the document body */
export const CONTENT_FIELD = 'content';

// ---- Awareness state ------------------------------------------------------

export const RelativePositionJSONSchema = z.unknown();

export const AwarenessUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  avatarUrl: z.string().optional(),
});

export const AwarenessStateSchema = z.object({
  user: AwarenessUserSchema,
  role: RoleSchema,
  cursor: z
    .object({ anchor: RelativePositionJSONSchema, head: RelativePositionJSONSchema })
    .nullable()
    .optional(),
  lock: z.object({ blockId: z.string(), expiresAt: z.number() }).nullable().optional(),
  status: z.enum(['active', 'idle']).optional(),
  clientTs: z.number().optional(),
});
export type AwarenessState = z.infer<typeof AwarenessStateSchema>;

// ---- RPC -------------------------------------------------------------------

export const RPC_METHODS = [
  'lock.acquire',
  'lock.release',
  'lock.heartbeat',
  'lock.list',
  'annotation.broadcast',
  'admin.kick',
  'admin.forceSnapshot',
  'admin.broadcast',
  'ping',
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];

export const RpcRequestSchema = z.object({
  id: z.string().min(1).max(64),
  method: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export type RpcResult =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

export const RpcParams = {
  'lock.acquire': z.object({ blockId: z.string().min(1).max(64) }),
  'lock.release': z.object({ blockId: z.string().min(1).max(64) }),
  'lock.heartbeat': z.object({ blockIds: z.array(z.string().min(1).max(64)).max(200) }),
  'lock.list': z.object({}),
  'annotation.broadcast': z.object({
    kind: z.enum(['comment.focus', 'comment.typing']),
    commentId: z.string().optional(),
    blockId: z.string().optional(),
  }),
  'admin.kick': z.object({ userId: z.string() }),
  'admin.forceSnapshot': z.object({}),
  'admin.broadcast': z.object({ message: z.string().max(500) }),
  ping: z.object({ t: z.number() }),
} as const;

export const LockHolderSchema = z.object({
  userId: z.string(),
  clientId: z.string(),
  name: z.string(),
  color: z.string(),
  expiresAt: z.number(),
});
export type LockHolder = z.infer<typeof LockHolderSchema>;

// ---- Server events -----------------------------------------------------------

export type ServerEventType =
  | 'lock.changed'
  | 'role.changed'
  | 'permission.changed'
  | 'comment.created'
  | 'comment.updated'
  | 'comment.deleted'
  | 'annotation'
  | 'doc.deleted'
  | 'doc.updated'
  | 'kicked'
  | 'error'
  | 'admin.broadcast'
  | 'connected';

export interface ServerEvent<T = unknown> {
  type: ServerEventType;
  payload: T;
  ts: number;
}

/** Ticket payload stored in KV under ticket:{ticket}. */
export const TicketPayloadSchema = z.object({
  userId: z.string(),
  docId: z.string(),
  role: RoleSchema,
  name: z.string(),
  color: z.string(),
  iat: z.number(),
});
export type TicketPayload = z.infer<typeof TicketPayloadSchema>;

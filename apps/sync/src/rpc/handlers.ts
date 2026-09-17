import { RpcParams, type RpcRequest, type RpcResult, type ServerEventType } from '@confluo/shared';
import type { LockService } from '../locks/lock-service.js';
import type { Metrics } from '../metrics.js';
import type { Connection } from '../ws/connection.js';

export interface RpcContext {
  locks: LockService;
  metrics: Metrics;
  nodeId: string;
  publishEvent(docId: string, type: ServerEventType | 'kick', payload: unknown): Promise<void>;
}

function err(id: string, code: string, message: string): RpcResult {
  return { id, ok: false, error: { code, message } };
}

/** Dispatch a validated (and gated) RPC request. Common doc §8.5. */
export async function handleRpc(ctx: RpcContext, conn: Connection, req: RpcRequest): Promise<RpcResult> {
  const method = req.method as keyof typeof RpcParams;
  const schema = RpcParams[method];
  if (!schema) return err(req.id, 'UNKNOWN_METHOD', `unknown rpc method ${req.method}`);
  const parsed = schema.safeParse(req.params);
  if (!parsed.success) return err(req.id, 'VALIDATION_FAILED', parsed.error.message);
  const end = ctx.metrics.rpcSeconds.startTimer({ method });
  try {
    const result = await dispatch(ctx, conn, method, parsed.data as never);
    return { id: req.id, ok: true, result };
  } catch (e) {
    return err(req.id, 'INTERNAL', e instanceof Error ? e.message : 'rpc failed');
  } finally {
    end();
  }
}

type Params<M extends keyof typeof RpcParams> = ReturnType<(typeof RpcParams)[M]['parse']>;

async function dispatch(
  ctx: RpcContext,
  conn: Connection,
  method: keyof typeof RpcParams,
  params: unknown,
): Promise<unknown> {
  switch (method) {
    case 'lock.acquire': {
      const p = params as Params<'lock.acquire'>;
      const res = await ctx.locks.acquire(conn, p.blockId);
      ctx.metrics.lockAcquire.inc({ granted: String(res.granted) });
      return res;
    }
    case 'lock.release': {
      const p = params as Params<'lock.release'>;
      return { released: await ctx.locks.release(conn, p.blockId) };
    }
    case 'lock.heartbeat': {
      const p = params as Params<'lock.heartbeat'>;
      return ctx.locks.heartbeat(conn, p.blockIds);
    }
    case 'lock.list':
      return { locks: await ctx.locks.list(conn.docId) };
    case 'annotation.broadcast': {
      const p = params as Params<'annotation.broadcast'>;
      await ctx.publishEvent(conn.docId, 'annotation', {
        from: { userId: conn.userId, name: conn.name, color: conn.color, clientId: conn.clientId },
        ...p,
      });
      return {};
    }
    case 'admin.kick': {
      const p = params as Params<'admin.kick'>;
      const local = conn.room.connectionsOf(p.userId).length;
      await ctx.publishEvent(conn.docId, 'kick', { userId: p.userId, by: conn.userId });
      return { closed: local };
    }
    case 'admin.forceSnapshot': {
      const res = await conn.room.compact();
      if (!res) return { snapshotId: null, byteSize: conn.room.stateBytes(), skipped: true };
      return res;
    }
    case 'admin.broadcast': {
      const p = params as Params<'admin.broadcast'>;
      await ctx.publishEvent(conn.docId, 'admin.broadcast', { message: p.message, from: conn.name });
      return {};
    }
    case 'ping': {
      const p = params as Params<'ping'>;
      return { t: p.t, serverTs: Date.now() };
    }
    default:
      throw new Error('unreachable');
  }
}

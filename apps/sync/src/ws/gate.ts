import {
  can,
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_RPC,
  MESSAGE_SYNC,
  SYNC_STEP1,
  SYNC_STEP2,
  SYNC_UPDATE,
  type Role,
} from '@confluo/shared';

export type GateDecision = 'allow' | 'drop' | 'error';

/**
 * Pure permission gate applied to every inbound frame (common doc §8.4).
 * - `allow`: handle normally
 * - `drop`:  silently ignore (never applied, broadcast or persisted)
 * - `error`: reply with an RPC error / refuse
 *
 * `subType` is the sync sub-type for MESSAGE_SYNC, or the RPC method name for MESSAGE_RPC.
 */
export function gate(role: Role, messageType: number, subType?: number | string): GateDecision {
  switch (messageType) {
    case MESSAGE_SYNC: {
      if (subType === SYNC_STEP1) return can(role, 'ws.connect') ? 'allow' : 'drop';
      if (subType === SYNC_STEP2 || subType === SYNC_UPDATE) {
        return can(role, 'ws.edit') ? 'allow' : 'drop';
      }
      return 'drop';
    }
    case MESSAGE_AWARENESS:
    case MESSAGE_QUERY_AWARENESS:
      return can(role, 'ws.presence') ? 'allow' : 'drop';
    case MESSAGE_RPC: {
      const method = typeof subType === 'string' ? subType : '';
      if (method === 'ping') return 'allow';
      if (method.startsWith('lock.')) return can(role, 'ws.lock') ? 'allow' : 'error';
      if (method === 'annotation.broadcast') return can(role, 'ws.annotate') ? 'allow' : 'error';
      if (method.startsWith('admin.')) return can(role, 'ws.admin') ? 'allow' : 'error';
      // Unknown methods are allowed through so the RPC layer answers UNKNOWN_METHOD.
      return 'allow';
    }
    default:
      return 'drop';
  }
}

/** Whether the awareness `lock` field must be stripped from this role's presence. */
export function mustStripLock(role: Role): boolean {
  return !can(role, 'ws.lock');
}

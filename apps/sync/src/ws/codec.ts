import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import {
  MESSAGE_AWARENESS,
  MESSAGE_RPC_RESULT,
  MESSAGE_SERVER_EVENT,
  MESSAGE_SYNC,
  type RpcResult,
  type ServerEvent,
  type ServerEventType,
} from '@confluo/shared';

export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(enc, doc);
  return encoding.toUint8Array(enc);
}

export function encodeSyncStep2(doc: Y.Doc, stateVector?: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeSyncStep2(enc, doc, stateVector);
  return encoding.toUint8Array(enc);
}

export function encodeUpdate(update: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
}

export function encodeAwareness(awareness: awarenessProtocol.Awareness, clients: number[]): Uint8Array {
  return encodeAwarenessRaw(awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
}

export function encodeAwarenessRaw(update: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(enc, update);
  return encoding.toUint8Array(enc);
}

export function encodeRpcResult(result: RpcResult): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_RPC_RESULT);
  encoding.writeVarString(enc, JSON.stringify(result));
  return encoding.toUint8Array(enc);
}

export function makeEvent<T>(type: ServerEventType, payload: T): ServerEvent<T> {
  return { type, payload, ts: Date.now() };
}

export function encodeServerEvent(evt: ServerEvent): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SERVER_EVENT);
  encoding.writeVarString(enc, JSON.stringify(evt));
  return encoding.toUint8Array(enc);
}

/** Bus frame for doc:{id}:updates and doc:{id}:awareness channels. */
export function encodeBusFrame(nodeId: string, bytes: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarString(enc, nodeId);
  encoding.writeVarUint8Array(enc, bytes);
  return encoding.toUint8Array(enc);
}

export function decodeBusFrame(data: Uint8Array | string): { nodeId: string; bytes: Uint8Array } | null {
  if (typeof data === 'string') return null;
  try {
    const dec = decoding.createDecoder(data);
    const nodeId = decoding.readVarString(dec);
    const bytes = decoding.readVarUint8Array(dec);
    return { nodeId, bytes };
  } catch {
    return null;
  }
}

export function busDataToString(data: Uint8Array | string): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

/**
 * Decode an awareness update to learn which clientIDs it carries, and optionally
 * rewrite each state to remove the `lock` field (read-only roles, common doc §8.4).
 */
export function inspectAwarenessUpdate(
  update: Uint8Array,
  stripLock: boolean,
): { clientIds: number[]; update: Uint8Array } {
  const dec = decoding.createDecoder(update);
  const enc = encoding.createEncoder();
  const len = decoding.readVarUint(dec);
  encoding.writeVarUint(enc, len);
  const clientIds: number[] = [];
  for (let i = 0; i < len; i++) {
    const clientId = decoding.readVarUint(dec);
    const clock = decoding.readVarUint(dec);
    const stateStr = decoding.readVarString(dec);
    clientIds.push(clientId);
    let out = stateStr;
    if (stripLock && stateStr !== 'null') {
      try {
        const s = JSON.parse(stateStr) as Record<string, unknown> | null;
        if (s && typeof s === 'object' && 'lock' in s && s.lock !== null) {
          s.lock = null;
          out = JSON.stringify(s);
        }
      } catch {
        /* leave as is */
      }
    }
    encoding.writeVarUint(enc, clientId);
    encoding.writeVarUint(enc, clock);
    encoding.writeVarString(enc, out);
  }
  return { clientIds, update: stripLock ? encoding.toUint8Array(enc) : update };
}

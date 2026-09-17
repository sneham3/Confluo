import { describe, expect, it } from 'vitest';
import {
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_RPC,
  MESSAGE_SYNC,
  ROLES,
  SYNC_STEP1,
  SYNC_STEP2,
  SYNC_UPDATE,
  type Role,
} from '@confluo/shared';
import { gate, mustStripLock, type GateDecision } from './gate.js';

type Row = { type: number; sub?: number | string; expect: Record<Role, GateDecision> };

const A = 'allow', D = 'drop', E = 'error';
const rows: Row[] = [
  { type: MESSAGE_SYNC, sub: SYNC_STEP1, expect: { viewer: A, commenter: A, editor: A, owner: A } },
  { type: MESSAGE_SYNC, sub: SYNC_STEP2, expect: { viewer: D, commenter: D, editor: A, owner: A } },
  { type: MESSAGE_SYNC, sub: SYNC_UPDATE, expect: { viewer: D, commenter: D, editor: A, owner: A } },
  { type: MESSAGE_SYNC, sub: 9, expect: { viewer: D, commenter: D, editor: D, owner: D } },
  { type: MESSAGE_AWARENESS, expect: { viewer: A, commenter: A, editor: A, owner: A } },
  { type: MESSAGE_QUERY_AWARENESS, expect: { viewer: A, commenter: A, editor: A, owner: A } },
  { type: MESSAGE_RPC, sub: 'lock.acquire', expect: { viewer: E, commenter: E, editor: A, owner: A } },
  { type: MESSAGE_RPC, sub: 'lock.release', expect: { viewer: E, commenter: E, editor: A, owner: A } },
  { type: MESSAGE_RPC, sub: 'lock.heartbeat', expect: { viewer: E, commenter: E, editor: A, owner: A } },
  { type: MESSAGE_RPC, sub: 'lock.list', expect: { viewer: E, commenter: E, editor: A, owner: A } },
  { type: MESSAGE_RPC, sub: 'annotation.broadcast', expect: { viewer: E, commenter: A, editor: A, owner: A } },
  { type: MESSAGE_RPC, sub: 'admin.kick', expect: { viewer: E, commenter: E, editor: E, owner: A } },
  { type: MESSAGE_RPC, sub: 'admin.forceSnapshot', expect: { viewer: E, commenter: E, editor: E, owner: A } },
  { type: MESSAGE_RPC, sub: 'admin.broadcast', expect: { viewer: E, commenter: E, editor: E, owner: A } },
  { type: MESSAGE_RPC, sub: 'ping', expect: { viewer: A, commenter: A, editor: A, owner: A } },
  { type: MESSAGE_RPC, sub: 'nope', expect: { viewer: A, commenter: A, editor: A, owner: A } },
  { type: 99, expect: { viewer: D, commenter: D, editor: D, owner: D } },
];

describe('gate', () => {
  for (const row of rows) {
    for (const role of ROLES) {
      it(`${role} type=${row.type} sub=${String(row.sub)} → ${row.expect[role]}`, () => {
        expect(gate(role, row.type, row.sub)).toBe(row.expect[role]);
      });
    }
  }
  it('strips lock for read-only roles only', () => {
    expect(mustStripLock('viewer')).toBe(true);
    expect(mustStripLock('commenter')).toBe(true);
    expect(mustStripLock('editor')).toBe(false);
    expect(mustStripLock('owner')).toBe(false);
  });
});

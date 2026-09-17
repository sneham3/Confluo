import { describe, expect, it } from 'vitest';
import { ACTIONS, can, type Action } from './permissions.js';
import { ROLES, type Role } from './roles.js';

// Expected matrix from common doc §9. 1 = allowed.
const expected: Record<Action, Record<Role, 0 | 1>> = {
  'doc.read': { viewer: 1, commenter: 1, editor: 1, owner: 1 },
  'doc.comment': { viewer: 0, commenter: 1, editor: 1, owner: 1 },
  'doc.edit': { viewer: 0, commenter: 0, editor: 1, owner: 1 },
  'doc.uploadAsset': { viewer: 0, commenter: 0, editor: 1, owner: 1 },
  'doc.managePermissions': { viewer: 0, commenter: 0, editor: 0, owner: 1 },
  'doc.delete': { viewer: 0, commenter: 0, editor: 0, owner: 1 },
  'ws.connect': { viewer: 1, commenter: 1, editor: 1, owner: 1 },
  'ws.presence': { viewer: 1, commenter: 1, editor: 1, owner: 1 },
  'ws.edit': { viewer: 0, commenter: 0, editor: 1, owner: 1 },
  'ws.annotate': { viewer: 0, commenter: 1, editor: 1, owner: 1 },
  'ws.lock': { viewer: 0, commenter: 0, editor: 1, owner: 1 },
  'ws.admin': { viewer: 0, commenter: 0, editor: 0, owner: 1 },
};

describe('permission matrix', () => {
  for (const action of ACTIONS) {
    for (const role of ROLES) {
      it(`${role} ${expected[action][role] ? 'can' : 'cannot'} ${action}`, () => {
        expect(can(role, action)).toBe(expected[action][role] === 1);
      });
    }
  }
  it('null role can do nothing', () => {
    for (const action of ACTIONS) expect(can(null, action)).toBe(false);
  });
});

import { isAtLeast, type Role } from './roles.js';

export const ACTIONS = [
  'doc.read',
  'doc.comment',
  'doc.edit',
  'doc.uploadAsset',
  'doc.managePermissions',
  'doc.delete',
  'ws.connect',
  'ws.presence',
  'ws.edit',
  'ws.annotate',
  'ws.lock',
  'ws.admin',
] as const;
export type Action = (typeof ACTIONS)[number];

/** Minimum role required for each action (common doc §9). */
export const MIN_ROLE: Record<Action, Role> = {
  'doc.read': 'viewer',
  'doc.comment': 'commenter',
  'doc.edit': 'editor',
  'doc.uploadAsset': 'editor',
  'doc.managePermissions': 'owner',
  'doc.delete': 'owner',
  'ws.connect': 'viewer',
  'ws.presence': 'viewer',
  'ws.edit': 'editor',
  'ws.annotate': 'commenter',
  'ws.lock': 'editor',
  'ws.admin': 'owner',
};

export function can(role: Role | null | undefined, action: Action): boolean {
  return isAtLeast(role, MIN_ROLE[action]);
}

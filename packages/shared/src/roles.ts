import { z } from 'zod';

export const ROLES = ['viewer', 'commenter', 'editor', 'owner'] as const;
export type Role = (typeof ROLES)[number];
export const RoleSchema = z.enum(ROLES);

export const RoleRank: Record<Role, number> = {
  viewer: 0,
  commenter: 1,
  editor: 2,
  owner: 3,
};

export function isAtLeast(role: Role | null | undefined, min: Role): boolean {
  if (!role) return false;
  return RoleRank[role] >= RoleRank[min];
}

export function maxRole(a: Role | null | undefined, b: Role | null | undefined): Role | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return RoleRank[a] >= RoleRank[b] ? a : b;
}

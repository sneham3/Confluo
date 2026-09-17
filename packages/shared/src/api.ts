import { z } from 'zod';
import { RoleSchema } from './roles.js';

// ---- Common ----------------------------------------------------------------

export const UserPublicSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  avatarUrl: z.string().nullable().optional(),
});
export type UserPublic = z.infer<typeof UserPublicSchema>;

export const UserSchema = UserPublicSchema.extend({
  email: z.string(),
  createdAt: z.string(),
});
export type User = z.infer<typeof UserSchema>;

// ---- Auth ------------------------------------------------------------------

export const RegisterBody = z.object({
  email: z.email().max(254),
  password: z.string().min(10).max(200),
  displayName: z.string().trim().min(1).max(80),
});
export const LoginBody = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});
export const AuthResponse = z.object({ user: UserSchema, accessToken: z.string() });
export type AuthResponse = z.infer<typeof AuthResponse>;
export const RefreshResponse = z.object({ accessToken: z.string() });

// ---- Docs ------------------------------------------------------------------

export const DocSchema = z.object({
  id: z.string(),
  title: z.string(),
  version: z.number(),
  ownerId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Doc = z.infer<typeof DocSchema>;

export const DocSummarySchema = DocSchema.extend({
  role: RoleSchema,
  collaboratorCount: z.number(),
});
export type DocSummary = z.infer<typeof DocSummarySchema>;

export const CollaboratorSchema = UserPublicSchema.extend({ role: RoleSchema });
export type Collaborator = z.infer<typeof CollaboratorSchema>;

export const DocDetailResponse = z.object({
  doc: DocSchema,
  role: RoleSchema,
  collaborators: z.array(CollaboratorSchema),
});
export type DocDetailResponse = z.infer<typeof DocDetailResponse>;

export const DocListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const DocListResponse = z.object({
  items: z.array(DocSummarySchema),
  nextCursor: z.string().nullable(),
});
export type DocListResponse = z.infer<typeof DocListResponse>;

export const CreateDocBody = z.object({ title: z.string().trim().max(200).optional() });
export const PatchDocBody = z.object({ title: z.string().trim().min(1).max(200) });

export const ContentQuery = z.object({ format: z.enum(['json', 'html', 'text']).default('json') });
export const ContentResponse = z.object({
  format: z.enum(['json', 'html', 'text']),
  version: z.object({ uptoUpdateId: z.number() }),
  content: z.unknown(),
});

export const SocketTicketResponse = z.object({
  ticket: z.string(),
  wsUrl: z.string(),
  role: RoleSchema,
  expiresAt: z.string(),
});
export type SocketTicketResponse = z.infer<typeof SocketTicketResponse>;

// ---- Permissions & sharing ---------------------------------------------------

export const PermissionItemSchema = z.object({
  user: UserPublicSchema,
  role: RoleSchema,
  grantedBy: z.string(),
  createdAt: z.string(),
});
export const PermissionListResponse = z.object({ items: z.array(PermissionItemSchema) });
export const SetPermissionBody = z.object({ role: z.enum(['viewer', 'commenter', 'editor']) });

export const CreateShareLinkBody = z.object({
  role: z.enum(['viewer', 'commenter', 'editor']),
  expiresInHours: z.number().int().min(1).max(24 * 365).optional(),
});
export const ShareLinkSchema = z.object({
  id: z.string(),
  role: RoleSchema,
  url: z.string().optional(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});
export const ShareLinkListResponse = z.object({ items: z.array(ShareLinkSchema) });
export const AcceptShareResponse = z.object({ docId: z.string(), role: RoleSchema });

// ---- Comments ----------------------------------------------------------------

export const CommentSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  author: UserPublicSchema,
  parentId: z.string().nullable(),
  anchorFrom: z.string().nullable(), // base64 relative position
  anchorTo: z.string().nullable(),
  blockId: z.string().nullable(),
  body: z.string(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Comment = z.infer<typeof CommentSchema>;

export const CommentListQuery = z.object({
  includeResolved: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .default(false),
});
export const CommentListResponse = z.object({ items: z.array(CommentSchema) });
export const CreateCommentBody = z.object({
  body: z.string().trim().min(1).max(5000),
  anchorFrom: z.string().max(400).optional(),
  anchorTo: z.string().max(400).optional(),
  blockId: z.string().max(64).optional(),
  parentId: z.string().optional(),
});
export const PatchCommentBody = z.object({
  body: z.string().trim().min(1).max(5000).optional(),
  resolved: z.boolean().optional(),
});

// ---- Assets ------------------------------------------------------------------

export const ALLOWED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

export const PresignBody = z.object({
  mime: z.enum(ALLOWED_IMAGE_MIMES),
  byteSize: z.number().int().positive().max(MAX_ASSET_BYTES),
  filename: z.string().max(255),
});
export const PresignResponse = z.object({
  assetId: z.string(),
  uploadUrl: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string(),
});
export type PresignResponse = z.infer<typeof PresignResponse>;
export const AssetSchema = z.object({
  id: z.string(),
  url: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
});
export const CompleteAssetResponse = z.object({ asset: AssetSchema });

// ---- Users ---------------------------------------------------------------------

export const LookupQuery = z.object({ email: z.email() });
export const LookupResponse = z.object({ user: UserPublicSchema });

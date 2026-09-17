'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AcceptShareResponse,
  CommentListResponse,
  CommentSchema,
  DocDetailResponse,
  DocListResponse,
  DocSchema,
  LookupResponse,
  PermissionListResponse,
  ShareLinkListResponse,
  ShareLinkSchema,
  SocketTicketResponse,
  type Comment,
  type Role,
} from '@confluo/shared';
import { api } from './api-client';

export const keys = {
  docs: ['docs'] as const,
  doc: (id: string) => ['doc', id] as const,
  comments: (id: string) => ['comments', id] as const,
  permissions: (id: string) => ['permissions', id] as const,
  shareLinks: (id: string) => ['share-links', id] as const,
};

export function useDocs(enabled = true) {
  return useQuery({
    queryKey: keys.docs,
    queryFn: async () => DocListResponse.parse(await api.get('/docs?limit=100')),
    enabled,
  });
}

export function useDoc(id: string | null) {
  return useQuery({
    queryKey: keys.doc(id ?? ''),
    queryFn: async () => DocDetailResponse.parse(await api.get(`/docs/${id}`)),
    enabled: !!id,
    retry: (count, err) => !(err instanceof Error && 'status' in err && [401, 403, 404].includes((err as { status: number }).status)) && count < 2,
  });
}

export function useCreateDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (title?: string) => {
      const r = await api.post<{ doc: unknown }>('/docs', title ? { title } : {});
      return DocSchema.parse(r.doc);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.docs }),
  });
}

export function useRenameDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, title, version }: { id: string; title: string; version: number }) => {
      const r = await api.patch<{ doc: unknown }>(`/docs/${id}`, { title }, { headers: { 'If-Match': `"${version}"` } });
      return DocSchema.parse(r.doc);
    },
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: keys.docs });
      void qc.invalidateQueries({ queryKey: keys.doc(v.id) });
    },
  });
}

export function useDeleteDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => api.delete(`/docs/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.docs }),
  });
}

export async function fetchTicket(docId: string) {
  return SocketTicketResponse.parse(await api.post(`/docs/${docId}/socket-ticket`));
}

// ---- Comments -----------------------------------------------------------------------------

export function useComments(docId: string | null, includeResolved: boolean) {
  return useQuery({
    queryKey: [...keys.comments(docId ?? ''), includeResolved],
    queryFn: async () => CommentListResponse.parse(await api.get(`/docs/${docId}/comments?includeResolved=${includeResolved}`)).items,
    enabled: !!docId,
  });
}

export function useCreateComment(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { body: string; anchorFrom?: string; anchorTo?: string; blockId?: string; parentId?: string }) => {
      const r = await api.post<{ comment: unknown }>(`/docs/${docId}/comments`, body);
      return CommentSchema.parse(r.comment);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.comments(docId) }),
  });
}

export function usePatchComment(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string; body?: string; resolved?: boolean }) => {
      const r = await api.patch<{ comment: unknown }>(`/comments/${id}`, body);
      return CommentSchema.parse(r.comment);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.comments(docId) }),
  });
}

export function useDeleteComment(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => api.delete(`/comments/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.comments(docId) }),
  });
}

export function applyCommentEvent(qc: ReturnType<typeof useQueryClient>, docId: string, type: string, comment: Comment) {
  qc.setQueriesData<Comment[]>({ queryKey: keys.comments(docId) }, (old) => {
    if (!old) return old;
    if (type === 'comment.deleted') return old.filter((c) => c.id !== comment.id && c.parentId !== comment.id);
    const idx = old.findIndex((c) => c.id === comment.id);
    if (idx === -1) return [...old, comment];
    const next = old.slice();
    next[idx] = comment;
    return next;
  });
}

// ---- Permissions & sharing ---------------------------------------------------------------

export function usePermissions(docId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: keys.permissions(docId ?? ''),
    queryFn: async () => PermissionListResponse.parse(await api.get(`/docs/${docId}/permissions`)).items,
    enabled: !!docId && enabled,
  });
}

export function useSetPermission(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: Exclude<Role, 'owner'> }) =>
      api.put(`/docs/${docId}/permissions/${userId}`, { role }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.permissions(docId) });
      void qc.invalidateQueries({ queryKey: keys.doc(docId) });
    },
  });
}

export function useRemovePermission(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => api.delete(`/docs/${docId}/permissions/${userId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.permissions(docId) });
      void qc.invalidateQueries({ queryKey: keys.doc(docId) });
    },
  });
}

export async function lookupUser(email: string) {
  return LookupResponse.parse(await api.get(`/users/lookup?email=${encodeURIComponent(email)}`)).user;
}

export function useShareLinks(docId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: keys.shareLinks(docId ?? ''),
    queryFn: async () => ShareLinkListResponse.parse(await api.get(`/docs/${docId}/share-links`)).items,
    enabled: !!docId && enabled,
  });
}

export function useCreateShareLink(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { role: Exclude<Role, 'owner'>; expiresInHours?: number }) =>
      ShareLinkSchema.parse(await api.post(`/docs/${docId}/share-links`, body)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.shareLinks(docId) }),
  });
}

export function useRevokeShareLink(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (linkId: string) => api.delete(`/docs/${docId}/share-links/${linkId}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.shareLinks(docId) }),
  });
}

export async function acceptShare(token: string) {
  return AcceptShareResponse.parse(await api.post(`/share/${token}/accept`));
}

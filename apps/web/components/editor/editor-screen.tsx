'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EditorContent } from '@tiptap/react';
import { ArrowLeft, MessageSquare, Share2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useCollabDoc, type ServerEvent } from '@confluo/editor';
import { can, type Comment, type DocDetailResponse, type Role } from '@confluo/shared';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { applyCommentEvent, fetchTicket, keys } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Button, Tip } from '@/components/ui';
import { TitleField } from './title-field';
import { Toolbar } from './toolbar';
import { PresenceStack } from './presence';
import { ConnectionBadge } from './connection-badge';
import { CommentsSidebar } from './comments-sidebar';
import { ShareDialog } from './share-dialog';

const SYNC_URL = process.env.NEXT_PUBLIC_SYNC_URL ?? (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/^http/, 'ws') + '/sync';

export function EditorScreen({ detail }: { detail: DocDetailResponse }) {
  const { user } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const docId = detail.doc.id;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [role, setRole] = useState<Role>(detail.role);
  const canvasRef = useRef<HTMLDivElement>(null);

  const onEvent = useCallback(
    (e: ServerEvent) => {
      switch (e.type) {
        case 'comment.created':
        case 'comment.updated':
        case 'comment.deleted':
          applyCommentEvent(qc, docId, e.type, (e.payload as { comment: Comment }).comment);
          void qc.invalidateQueries({ queryKey: keys.comments(docId) });
          break;
        case 'role.changed': {
          const r = (e.payload as { role: Role }).role;
          setRole(r);
          toast.info(`Your access changed to ${r}`);
          void qc.invalidateQueries({ queryKey: keys.doc(docId) });
          break;
        }
        case 'permission.changed':
          void qc.invalidateQueries({ queryKey: keys.doc(docId) });
          void qc.invalidateQueries({ queryKey: keys.permissions(docId) });
          break;
        case 'doc.deleted':
          toast.error('This document was deleted by its owner');
          router.replace('/docs');
          break;
        case 'kicked':
          toast.error('You were removed from this session by the owner');
          break;
        case 'admin.broadcast':
          toast.message((e.payload as { message: string }).message);
          break;
        default:
          break;
      }
    },
    [docId, qc, router],
  );

  const opts = useMemo(
    () =>
      user
        ? {
            docId,
            user: { id: user.id, name: user.name, color: user.color, avatarUrl: user.avatarUrl ?? undefined },
            role: detail.role,
            api,
            getTicket: () => fetchTicket(docId),
            syncUrl: SYNC_URL,
            title: { value: detail.doc.title, version: detail.doc.version },
            onEvent,
            onBlocked: (holder: { name: string }) => {
              toast.warning(`Paragraph is being edited by ${holder.name}`, { id: 'lock-blocked', duration: 1800 });
              shakeLocked();
            },
            onTitleAdopted: (d: { title: string }) => toast.info(`Renamed elsewhere to “${d.title}”`),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docId, user?.id],
  );

  const collab = useCollabDoc(opts);
  const { editor, connectionState, deniedReason, unsyncedChanges, peers, locks, uploads, ready } = collab;
  // Dev-only debugging hook (connection log, provider) for the browser console and e2e scripts.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' || typeof window === 'undefined') return;
    (window as unknown as { __confluo?: unknown }).__confluo = collab;
  }, [collab]);
  const effectiveRole = collab.role ?? role;
  const editable = can(effectiveRole, 'doc.edit') && connectionState !== 'denied';
  const canComment = can(effectiveRole, 'doc.comment');
  const isOwner = effectiveRole === 'owner';

  // Leave protection.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (unsyncedChanges || (uploads?.pending ?? 0) > 0) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [unsyncedChanges, uploads]);

  // Keyboard: toggle comments sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setSidebarOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Paste / drop images.
  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      if (!uploads || !editable) return;
      for (const f of Array.from(files)) if (f.type.startsWith('image/')) uploads.enqueue(f);
    },
    [uploads, editable],
  );

  const denied = connectionState === 'denied';

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky z-20 border-b border-line bg-surface/95 backdrop-blur" style={{ top: 'env(safe-area-inset-top, 0px)' }}>
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-3 sm:px-4">
          <Tip label="Back to documents">
            <Link href="/docs" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-accent-soft hover:text-ink" aria-label="Back to documents">
              <ArrowLeft size={18} />
            </Link>
          </Tip>
          <TitleField collab={collab} editable={editable} />
          <div className="ml-auto flex items-center gap-2">
            <PresenceStack peers={peers} />
            <ConnectionBadge state={connectionState} deniedReason={deniedReason} unsynced={unsyncedChanges} log={collab.log} />
            <Tip label="Comments (Ctrl+Shift+M)">
              <Button variant={sidebarOpen ? 'ghost' : 'ghost'} size="icon" active={sidebarOpen} onClick={() => setSidebarOpen((o) => !o)} aria-label="Toggle comments">
                <MessageSquare size={16} />
              </Button>
            </Tip>
            <Button variant={isOwner ? 'primary' : 'secondary'} size="sm" onClick={() => setShareOpen(true)}>
              {isOwner ? <Share2 size={14} /> : <Users size={14} />}
              <span className="hidden sm:inline">{isOwner ? 'Share' : 'Collaborators'}</span>
            </Button>
          </div>
        </div>
        {editable ? (
          <Toolbar editor={editor} locks={locks} uploads={uploads} onPickFiles={handleFiles} />
        ) : (
          <div className="border-t border-line bg-accent-soft/60 px-4 py-2 text-center text-[13px] text-ink" role="status">
            {denied
              ? deniedReason === 'deleted'
                ? 'This document no longer exists.'
                : deniedReason === 'kicked'
                  ? 'You were removed from this session.'
                  : deniedReason === 'unauthenticated'
                    ? 'Your session expired. Reload to sign in again.'
                    : 'Your access to this document was revoked.'
              : canComment
                ? 'You can view and comment on this document.'
                : 'You can view this document.'}
            {denied && (
              <Link href="/docs" className="ml-2 text-accent underline-offset-2 hover:underline">
                Back to documents
              </Link>
            )}
          </div>
        )}
      </header>

      <div className="mx-auto flex w-full max-w-[1400px] flex-1">
        <main
          id="main"
          ref={canvasRef}
          className="min-w-0 flex-1 px-4 py-8 sm:px-8"
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              handleFiles(e.clipboardData.files);
            }
          }}
          onDrop={(e) => {
            if (e.dataTransfer.files.length) {
              e.preventDefault();
              handleFiles(e.dataTransfer.files);
            }
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) e.preventDefault();
          }}
        >
          <div className="mx-auto max-w-[68ch]">
            {!ready || !editor ? (
              <p className="text-sm text-muted" role="status">
                Loading editor…
              </p>
            ) : (
              <EditorContent editor={editor} />
            )}
          </div>
        </main>
        <CommentsSidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          docId={docId}
          collab={collab}
          canComment={canComment}
          role={effectiveRole}
          className={cn('shrink-0')}
        />
      </div>

      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} detail={detail} isOwner={isOwner} />
    </div>
  );
}

function shakeLocked() {
  for (const el of document.querySelectorAll('.confluo-editor > .is-locked')) {
    el.classList.remove('lock-shake');
    // force reflow to restart the animation
    void (el as HTMLElement).offsetWidth;
    el.classList.add('lock-shake');
  }
}

'use client';

import { useMemo, useState } from 'react';
import { useEditorState } from '@tiptap/react';
import { Check, CornerDownRight, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { UseCollabDocResult } from '@confluo/editor';
import type { Comment, Role } from '@confluo/shared';
import { useAuth } from '@/lib/auth';
import { useComments, useCreateComment, useDeleteComment, usePatchComment } from '@/lib/queries';
import { cn, relativeTime } from '@/lib/utils';
import { Avatar, Button } from '@/components/ui';

export function CommentsSidebar({
  open,
  onClose,
  docId,
  collab,
  canComment,
  role,
  className,
}: {
  open: boolean;
  onClose: () => void;
  docId: string;
  collab: UseCollabDocResult;
  canComment: boolean;
  role: Role;
  className?: string;
}) {
  const { user } = useAuth();
  const [showResolved, setShowResolved] = useState(false);
  const comments = useComments(open ? docId : null, showResolved);
  const create = useCreateComment(docId);
  const patch = usePatchComment(docId);
  const remove = useDeleteComment(docId);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const editor = collab.editor;

  const sel = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? { empty: e.state.selection.empty, text: e.state.doc.textBetween(e.state.selection.from, e.state.selection.to, ' ') } : null),
  });

  const threads = useMemo(() => {
    const items = comments.data ?? [];
    const roots = items.filter((c) => !c.parentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const replies = new Map<string, Comment[]>();
    for (const c of items) {
      if (!c.parentId) continue;
      const arr = replies.get(c.parentId) ?? [];
      arr.push(c);
      replies.set(c.parentId, arr);
    }
    return roots.map((r) => ({ root: r, replies: (replies.get(r.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }));
  }, [comments.data]);

  function jumpTo(c: Comment) {
    if (!editor || !collab.comments) return;
    const range = collab.comments.resolveAnchor(c) ?? (c.blockId ? collab.comments.blockRange(c.blockId) : null);
    if (!range) {
      toast.message('Original text was removed');
      return;
    }
    editor.chain().focus().setTextSelection(range).scrollIntoView().run();
  }

  async function submit() {
    if (!draft.trim() || !collab.comments) return;
    const anchor = sel && !sel.empty ? collab.comments.anchorFromSelection() : null;
    try {
      await create.mutateAsync({ body: draft.trim(), ...(anchor ?? {}) });
      setDraft('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not post the comment');
    }
  }

  if (!open) return null;

  return (
    <aside
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 max-h-[70vh] border-t border-line bg-surface lg:static lg:max-h-none lg:w-[320px] lg:border-l lg:border-t-0',
        className,
      )}
      aria-label="Comments"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="font-semibold">Comments</h2>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[12px] text-muted">
              <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Resolved
            </label>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close comments">
              <X size={16} />
            </Button>
          </div>
        </div>

        {canComment && (
          <form
            className="border-b border-line px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label htmlFor="new-comment" className="text-[12px] text-muted">
              {sel && !sel.empty ? (
                <>
                  Commenting on <span className="text-ink">“{sel.text.slice(0, 40)}{sel.text.length > 40 ? '…' : ''}”</span>
                </>
              ) : (
                'Select text to anchor a comment, or post a general note.'
              )}
            </label>
            <textarea
              id="new-comment"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              maxLength={5000}
              placeholder="Write a comment…"
              className="mt-1.5 w-full resize-y rounded-md border border-line-strong bg-paper px-2.5 py-2 text-sm focus-visible:border-accent"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
              }}
            />
            <div className="mt-2 flex justify-end">
              <Button type="submit" variant="primary" size="sm" disabled={!draft.trim() || create.isPending}>
                Comment
              </Button>
            </div>
          </form>
        )}

        <div className="flex-1 overflow-auto px-3 py-3">
          {comments.isLoading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : threads.length === 0 ? (
            <p className="px-1 text-sm text-muted">No comments yet.</p>
          ) : (
            <ul className="space-y-3">
              {threads.map(({ root, replies }) => {
                const resolvable = canComment && (root.author.id === user?.id || role === 'editor' || role === 'owner');
                const deletable = root.author.id === user?.id || role === 'owner';
                return (
                  <li key={root.id} className={cn('rounded-md border border-line p-3', root.resolvedAt && 'opacity-70')}>
                    <CommentRow c={root} onJump={() => jumpTo(root)} />
                    <div className="mt-2 flex items-center gap-1">
                      {canComment && (
                        <Button variant="ghost" size="sm" onClick={() => setReplyTo(replyTo === root.id ? null : root.id)}>
                          <CornerDownRight size={12} /> Reply
                        </Button>
                      )}
                      {resolvable && (
                        <Button variant="ghost" size="sm" onClick={() => patch.mutate({ id: root.id, resolved: !root.resolvedAt })}>
                          <Check size={12} /> {root.resolvedAt ? 'Reopen' : 'Resolve'}
                        </Button>
                      )}
                      {deletable && (
                        <Button variant="danger" size="sm" className="ml-auto" onClick={() => remove.mutate(root.id)} aria-label="Delete comment">
                          <Trash2 size={12} />
                        </Button>
                      )}
                    </div>
                    {replies.length > 0 && (
                      <ul className="mt-2 space-y-2 border-l-2 border-line pl-3">
                        {replies.map((r) => (
                          <li key={r.id}>
                            <CommentRow c={r} small />
                            {(r.author.id === user?.id || role === 'owner') && (
                              <button type="button" className="mt-1 text-[11px] text-muted hover:text-danger" onClick={() => remove.mutate(r.id)}>
                                Delete
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {replyTo === root.id && (
                      <form
                        className="mt-2"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (!replyDraft.trim()) return;
                          try {
                            await create.mutateAsync({ body: replyDraft.trim(), parentId: root.id });
                            setReplyDraft('');
                            setReplyTo(null);
                          } catch (err) {
                            toast.error(err instanceof Error ? err.message : 'Could not reply');
                          }
                        }}
                      >
                        <textarea
                          value={replyDraft}
                          onChange={(e) => setReplyDraft(e.target.value)}
                          rows={2}
                          maxLength={5000}
                          aria-label="Reply"
                          placeholder="Reply…"
                          className="w-full rounded-md border border-line-strong bg-paper px-2.5 py-1.5 text-sm focus-visible:border-accent"
                          autoFocus
                        />
                        <div className="mt-1.5 flex justify-end gap-1">
                          <Button size="sm" onClick={() => setReplyTo(null)}>
                            Cancel
                          </Button>
                          <Button size="sm" variant="primary" type="submit" disabled={!replyDraft.trim()}>
                            Reply
                          </Button>
                        </div>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}

function CommentRow({ c, onJump, small }: { c: Comment; onJump?: () => void; small?: boolean }) {
  return (
    <div className="flex gap-2">
      <Avatar name={c.author.name} color={c.author.color} size={small ? 20 : 24} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[12px]">
          <span className="font-semibold text-ink">{c.author.name}</span>
          <time dateTime={c.createdAt} className="text-muted">
            {relativeTime(c.createdAt)}
          </time>
          {c.resolvedAt && <span className="text-success">resolved</span>}
        </div>
        <p className={cn('mt-0.5 whitespace-pre-wrap break-words', small ? 'text-[13px]' : 'text-sm')}>{c.body}</p>
        {onJump && (c.anchorFrom || c.blockId) && (
          <button type="button" onClick={onJump} className="mt-1 text-[12px] text-accent underline-offset-2 hover:underline">
            Show in document
          </button>
        )}
      </div>
    </div>
  );
}

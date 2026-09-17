'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FileText, LogOut, MoreHorizontal, Plus } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { toast } from 'sonner';
import type { DocSummary } from '@confluo/shared';
import { useAuth } from '@/lib/auth';
import { useCreateDoc, useDeleteDoc, useDocs, useRenameDoc } from '@/lib/queries';
import { relativeTime, ROLE_LABEL } from '@/lib/utils';
import { Avatar, Badge, Button, Dialog, Input } from '@/components/ui';

export default function DashboardPage() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const docs = useDocs();
  const create = useCreateDoc();
  const rename = useRenameDoc();
  const remove = useDeleteDoc();
  const [renaming, setRenaming] = useState<DocSummary | null>(null);
  const [title, setTitle] = useState('');
  const [deleting, setDeleting] = useState<DocSummary | null>(null);

  async function onCreate() {
    try {
      const doc = await create.mutateAsync(undefined);
      router.push(`/docs/${doc.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the document');
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Link href="/" className="font-display text-xl font-semibold">
            Confluo
          </Link>
          <div className="flex items-center gap-3">
            {user && (
              <span className="flex items-center gap-2 text-sm">
                <Avatar name={user.name} color={user.color} size={26} />
                <span className="hidden sm:inline">{user.name}</span>
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={() => void logout().then(() => router.replace('/'))}>
              <LogOut size={14} /> Log out
            </Button>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl font-semibold">Documents</h1>
            <p className="mt-1 text-sm text-muted">Everything you own or have been invited to.</p>
          </div>
          <Button variant="primary" onClick={onCreate} disabled={create.isPending}>
            <Plus size={16} /> New document
          </Button>
        </div>

        {docs.isLoading ? (
          <p className="mt-10 text-sm text-muted" role="status">
            Loading documents…
          </p>
        ) : docs.isError ? (
          <p className="mt-10 text-sm text-danger" role="alert">
            Could not load documents. {docs.error instanceof Error ? docs.error.message : ''}
          </p>
        ) : docs.data && docs.data.items.length === 0 ? (
          <div className="mt-12 flex flex-col items-center rounded-lg border border-dashed border-line-strong px-6 py-16 text-center">
            <FileText className="text-muted" size={32} aria-hidden />
            <h2 className="mt-4 font-display text-xl font-semibold">No documents yet</h2>
            <p className="mt-1 max-w-sm text-sm text-muted">Create your first document and share it with a link. Collaborators see your edits as you type.</p>
            <Button variant="primary" className="mt-6" onClick={onCreate} disabled={create.isPending}>
              Create your first document
            </Button>
          </div>
        ) : (
          <div className="mt-8 overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-[12px] uppercase tracking-wide text-muted">
                  <th className="px-4 py-3 font-semibold">Title</th>
                  <th className="px-4 py-3 font-semibold">Your role</th>
                  <th className="px-4 py-3 font-semibold">People</th>
                  <th className="px-4 py-3 font-semibold">Updated</th>
                  <th className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {docs.data?.items.map((d) => (
                  <tr key={d.id} className="border-t border-line hover:bg-accent-soft/40">
                    <td className="px-4 py-3">
                      <Link href={`/docs/${d.id}`} className="font-medium underline-offset-2 hover:underline">
                        {d.title || 'Untitled'}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={d.role === 'owner' ? 'accent' : 'neutral'}>{ROLE_LABEL[d.role]}</Badge>
                    </td>
                    <td className="px-4 py-3 text-muted">{d.collaboratorCount}</td>
                    <td className="px-4 py-3 text-muted">
                      <time dateTime={d.updatedAt}>{relativeTime(d.updatedAt)}</time>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Actions for ${d.title}`}>
                            <MoreHorizontal size={16} />
                          </Button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content align="end" className="z-40 min-w-40 rounded-md border border-line bg-surface p-1 text-sm shadow-lg">
                            <DropdownMenu.Item asChild>
                              <Link href={`/docs/${d.id}`} className="block rounded px-2 py-1.5 outline-none hover:bg-accent-soft focus:bg-accent-soft">
                                Open
                              </Link>
                            </DropdownMenu.Item>
                            {(d.role === 'editor' || d.role === 'owner') && (
                              <DropdownMenu.Item
                                className="rounded px-2 py-1.5 outline-none hover:bg-accent-soft focus:bg-accent-soft"
                                onSelect={() => {
                                  setRenaming(d);
                                  setTitle(d.title);
                                }}
                              >
                                Rename
                              </DropdownMenu.Item>
                            )}
                            {d.role === 'owner' && (
                              <DropdownMenu.Item className="rounded px-2 py-1.5 text-danger outline-none hover:bg-danger/10 focus:bg-danger/10" onSelect={() => setDeleting(d)}>
                                Delete
                              </DropdownMenu.Item>
                            )}
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)} title="Rename document">
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!renaming) return;
            try {
              await rename.mutateAsync({ id: renaming.id, title: title.trim() || 'Untitled', version: renaming.version });
              setRenaming(null);
            } catch (err) {
              toast.error(err instanceof Error ? err.message : 'Rename failed');
            }
          }}
        >
          <label htmlFor="rename-title" className="text-[13px] font-medium">
            Title
          </label>
          <Input id="rename-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRenaming(null)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={rename.isPending}>
              Save
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title="Delete document?" description="Collaborators lose access immediately. This can be undone by support within 30 days.">
        <div className="flex justify-end gap-2">
          <Button onClick={() => setDeleting(null)}>Cancel</Button>
          <Button
            variant="primary"
            className="bg-danger hover:bg-danger/90"
            disabled={remove.isPending}
            onClick={async () => {
              if (!deleting) return;
              try {
                await remove.mutateAsync(deleting.id);
                toast.success('Document deleted');
                setDeleting(null);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Delete failed');
              }
            }}
          >
            Delete
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

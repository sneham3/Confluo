'use client';

import { useState } from 'react';
import { Copy, Link2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { DocDetailResponse, Role } from '@confluo/shared';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api-client';
import {
  lookupUser,
  useCreateShareLink,
  usePermissions,
  useRemovePermission,
  useRevokeShareLink,
  useSetPermission,
  useShareLinks,
} from '@/lib/queries';
import { ROLE_LABEL } from '@/lib/utils';
import { Avatar, Badge, Button, Dialog, Input, Select } from '@/components/ui';

type Grantable = Exclude<Role, 'owner'>;
const GRANTABLE: Grantable[] = ['viewer', 'commenter', 'editor'];

export function ShareDialog({
  open,
  onOpenChange,
  detail,
  isOwner,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  detail: DocDetailResponse;
  isOwner: boolean;
}) {
  const docId = detail.doc.id;
  const { user } = useAuth();
  const perms = usePermissions(docId, open && isOwner);
  const links = useShareLinks(docId, open && isOwner);
  const setPerm = useSetPermission(docId);
  const removePerm = useRemovePermission(docId);
  const createLink = useCreateShareLink(docId);
  const revokeLink = useRevokeShareLink(docId);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Grantable>('editor');
  const [linkRole, setLinkRole] = useState<Grantable>('viewer');
  const [linkHours, setLinkHours] = useState<string>('168');
  const [busy, setBusy] = useState(false);
  const [freshLink, setFreshLink] = useState<string | null>(null);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    try {
      const u = await lookupUser(email.trim());
      if (u.id === user?.id) {
        toast.error('That is you.');
        return;
      }
      await setPerm.mutateAsync({ userId: u.id, role: inviteRole });
      toast.success(`${u.name} added as ${ROLE_LABEL[inviteRole]}`);
      setEmail('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) toast.error('No account with that email yet. Send them a share link instead.');
      else toast.error(err instanceof Error ? err.message : 'Could not add collaborator');
    } finally {
      setBusy(false);
    }
  }

  async function makeLink() {
    try {
      const l = await createLink.mutateAsync({ role: linkRole, expiresInHours: linkHours ? Number(linkHours) : undefined });
      const url = l.url ?? `${window.location.origin}/share/${l.id}`;
      setFreshLink(url);
      await copy(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create link');
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.message(url);
    }
  }

  if (!isOwner) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange} title="Collaborators" description="People with access to this document.">
        <ul className="divide-y divide-line">
          {detail.collaborators.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2">
              <Avatar name={c.name} color={c.color} size={28} />
              <span className="flex-1 text-sm">{c.name}</span>
              <Badge tone={c.role === 'owner' ? 'accent' : 'neutral'}>{ROLE_LABEL[c.role]}</Badge>
            </li>
          ))}
        </ul>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Share" description="Invite people by email or create a link with a role." wide>
      <form onSubmit={invite} className="flex flex-wrap gap-2">
        <label htmlFor="invite-email" className="sr-only">
          Email
        </label>
        <Input id="invite-email" type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} className="min-w-[200px] flex-1" />
        <Select aria-label="Role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Grantable)} className="h-10">
          {GRANTABLE.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="primary" disabled={busy || !email.trim()}>
          Add
        </Button>
      </form>

      <h3 className="mt-6 text-[13px] font-semibold uppercase tracking-wide text-muted">People</h3>
      <ul className="mt-2 divide-y divide-line">
        {(perms.data ?? []).map((p) => {
          const self = p.user.id === user?.id;
          return (
            <li key={p.user.id} className="flex items-center gap-3 py-2">
              <Avatar name={p.user.name} color={p.user.color} size={28} />
              <span className="min-w-0 flex-1 truncate text-sm">
                {p.user.name}
                {self && <span className="text-muted"> (you)</span>}
              </span>
              {p.role === 'owner' ? (
                <Badge tone="accent">Owner</Badge>
              ) : (
                <>
                  <Select aria-label={`Role for ${p.user.name}`} value={p.role} onChange={(e) => setPerm.mutate({ userId: p.user.id, role: e.target.value as Grantable })}>
                    {GRANTABLE.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </Select>
                  <Button variant="danger" size="icon" aria-label={`Remove ${p.user.name}`} onClick={() => removePerm.mutate(p.user.id)}>
                    <Trash2 size={14} />
                  </Button>
                </>
              )}
            </li>
          );
        })}
        {perms.isLoading && <li className="py-2 text-sm text-muted">Loading…</li>}
      </ul>

      <h3 className="mt-6 text-[13px] font-semibold uppercase tracking-wide text-muted">Share links</h3>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Select aria-label="Link role" value={linkRole} onChange={(e) => setLinkRole(e.target.value as Grantable)} className="h-10">
          {GRANTABLE.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </Select>
        <Select aria-label="Link expiry" value={linkHours} onChange={(e) => setLinkHours(e.target.value)} className="h-10">
          <option value="24">Expires in 1 day</option>
          <option value="168">Expires in 7 days</option>
          <option value="720">Expires in 30 days</option>
          <option value="">Never expires</option>
        </Select>
        <Button variant="primary" onClick={() => void makeLink()} disabled={createLink.isPending}>
          <Link2 size={14} /> Create link
        </Button>
      </div>
      {freshLink && (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-[13px]">
          <span className="min-w-0 flex-1 truncate">{freshLink}</span>
          <Button size="sm" onClick={() => void copy(freshLink)}>
            <Copy size={12} /> Copy
          </Button>
        </div>
      )}
      <ul className="mt-2 divide-y divide-line">
        {(links.data ?? []).map((l) => (
          <li key={l.id} className="flex items-center gap-3 py-2 text-sm">
            <Badge>{ROLE_LABEL[l.role]}</Badge>
            <span className="flex-1 text-muted">{l.expiresAt ? `Expires ${new Date(l.expiresAt).toLocaleDateString()}` : 'Never expires'}</span>
            <Button variant="danger" size="sm" onClick={() => revokeLink.mutate(l.id)}>
              Revoke
            </Button>
          </li>
        ))}
        {links.data && links.data.length === 0 && <li className="py-2 text-sm text-muted">No active links. New links are shown once, so copy them when created.</li>}
      </ul>
    </Dialog>
  );
}

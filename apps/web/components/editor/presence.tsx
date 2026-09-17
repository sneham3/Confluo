'use client';

import type { Peer } from '@confluo/editor';
import { ROLE_LABEL } from '@/lib/utils';
import { Avatar, Tip } from '@/components/ui';

export function PresenceStack({ peers, max = 5 }: { peers: Peer[]; max?: number }) {
  if (peers.length === 0) return null;
  const shown = peers.slice(0, max);
  const extra = peers.length - shown.length;
  return (
    <div className="flex items-center" aria-label={`${peers.length} other ${peers.length === 1 ? 'person' : 'people'} here`}>
      {shown.map((p, i) => (
        <Tip key={p.clientId} label={`${p.user.name} · ${ROLE_LABEL[p.role]}${p.status === 'idle' ? ' · idle' : ''}`}>
          <span className="-ml-1.5 first:ml-0 rounded-full ring-2 ring-surface" style={{ zIndex: shown.length - i }}>
            <Avatar name={p.user.name} color={p.user.color} size={28} dim={p.status === 'idle'} />
          </span>
        </Tip>
      ))}
      {extra > 0 && <span className="-ml-1.5 inline-flex h-7 w-7 items-center justify-center rounded-full bg-code-bg text-[11px] font-semibold text-muted ring-2 ring-surface">+{extra}</span>}
    </div>
  );
}

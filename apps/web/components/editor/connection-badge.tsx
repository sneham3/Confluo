'use client';

import * as Popover from '@radix-ui/react-popover';
import type { ConnectionLogEntry, ConnectionState, DeniedReason } from '@confluo/editor';
import { cn } from '@/lib/utils';

const LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  offline: 'Offline — saved on this device',
  denied: 'Access denied',
};

export function ConnectionBadge({
  state,
  deniedReason,
  unsynced,
  log,
}: {
  state: ConnectionState;
  deniedReason?: DeniedReason;
  unsynced: boolean;
  log: ConnectionLogEntry[];
}) {
  const tone =
    state === 'connected'
      ? 'text-success'
      : state === 'reconnecting' || state === 'connecting'
        ? 'text-warning'
        : state === 'denied'
          ? 'text-danger'
          : 'text-muted';
  const dot =
    state === 'connected' ? 'bg-success' : state === 'reconnecting' || state === 'connecting' ? 'bg-warning animate-pulse' : state === 'denied' ? 'bg-danger' : 'bg-muted';
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn('inline-flex h-8 items-center gap-2 rounded-full border border-line px-2.5 text-[12px] font-medium hover:border-accent', tone)}
          aria-live="polite"
          aria-label={`Connection: ${LABEL[state]}${unsynced ? ', unsynced changes' : ''}`}
        >
          <span className={cn('h-2 w-2 rounded-full', dot)} aria-hidden />
          <span className="hidden sm:inline">{state === 'denied' && deniedReason ? `Access denied (${deniedReason})` : LABEL[state]}</span>
          {unsynced && <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Unsynced changes" aria-hidden />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="z-40 w-80 rounded-md border border-line bg-surface p-3 text-[12px] shadow-lg">
          <p className="mb-2 font-semibold text-ink">
            {LABEL[state]}
            {unsynced ? ' · changes waiting to sync' : ''}
          </p>
          <ol className="max-h-56 space-y-1 overflow-auto font-mono text-muted">
            {log.length === 0 ? <li>No events yet.</li> : null}
            {log
              .slice(-10)
              .reverse()
              .map((e, i) => (
                <li key={`${e.ts}-${i}`} className={cn(e.level === 'error' && 'text-danger', e.level === 'warn' && 'text-warning')}>
                  <time dateTime={new Date(e.ts).toISOString()}>{new Date(e.ts).toLocaleTimeString()}</time> {e.message}
                </li>
              ))}
          </ol>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

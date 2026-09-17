'use client';

import { useEffect, useState } from 'react';
import type { UseCollabDocResult } from '@confluo/editor';
import { cn } from '@/lib/utils';

export function TitleField({ collab, editable }: { collab: UseCollabDocResult; editable: boolean }) {
  const [value, setValue] = useState(collab.title);
  const [focused, setFocused] = useState(false);

  // Adopt remote renames while not typing.
  useEffect(() => {
    if (!focused) setValue(collab.title);
  }, [collab.title, focused]);

  const status =
    collab.titleState === 'saving'
      ? 'Saving…'
      : collab.titleState === 'pending'
        ? 'Unsaved'
        : collab.titleState === 'error'
          ? 'Couldn’t save'
          : 'Saved';

  return (
    <div className="flex min-w-0 items-center gap-2">
      <input
        aria-label="Document title"
        className={cn(
          'h-9 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 font-display text-lg font-semibold text-ink outline-none',
          editable ? 'hover:border-line focus:border-accent' : 'cursor-default',
        )}
        value={value}
        readOnly={!editable}
        maxLength={200}
        placeholder="Untitled"
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          void collab.titleSave?.flush();
        }}
        onChange={(e) => {
          setValue(e.target.value);
          collab.setTitle(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        style={{ width: `${Math.min(48, Math.max(8, value.length + 2))}ch` }}
      />
      {editable && (
        <span className={cn('hidden text-[12px] sm:inline', collab.titleState === 'error' ? 'text-danger' : 'text-muted')} aria-live="polite">
          {status}
          {collab.titleState === 'error' && (
            <button type="button" className="ml-1 text-accent underline-offset-2 hover:underline" onClick={() => void collab.titleSave?.flush()}>
              retry
            </button>
          )}
        </span>
      )}
    </div>
  );
}

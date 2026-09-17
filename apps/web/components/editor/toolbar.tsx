'use client';

import { useRef } from 'react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { Bold, Heading1, Heading2, Heading3, Image as ImageIcon, Italic, List, ListOrdered, Redo2, Undo2 } from 'lucide-react';
import { selectionBlocks, type LockHolder, type UploadManager } from '@confluo/editor';
import { Button, Tip } from '@/components/ui';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl';

export function Toolbar({
  editor,
  locks,
  uploads,
  onPickFiles,
}: {
  editor: Editor | null;
  locks: Map<string, LockHolder>;
  uploads: UploadManager | null;
  onPickFiles: (files: FileList) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      const blocks = selectionBlocks(e.state);
      return {
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        h1: e.isActive('heading', { level: 1 }),
        h2: e.isActive('heading', { level: 2 }),
        h3: e.isActive('heading', { level: 3 }),
        bullet: e.isActive('bulletList'),
        ordered: e.isActive('orderedList'),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
        inLocked: blocks.some((b) => locks.has(b)),
      };
    },
  });
  const disabled = !editor || !state;
  // Someone else is writing in this paragraph. Typing and inline formatting stay available (the CRDT
  // merges them); only re-typing the whole block is held back, because that replaces the paragraph
  // they are writing in.
  const blockTypeDisabled = disabled || !!state?.inLocked;
  const lockName = state?.inLocked ? locks.get(selectionBlocks(editor!.state).find((b) => locks.has(b))!)?.name : null;

  const items: Array<{ label: string; icon: React.ReactNode; active?: boolean; run: () => void; disabled?: boolean }> = [
    { label: `Bold (${mod}+B)`, icon: <Bold size={16} />, active: state?.bold, run: () => editor?.chain().focus().toggleBold().run() },
    { label: `Italic (${mod}+I)`, icon: <Italic size={16} />, active: state?.italic, run: () => editor?.chain().focus().toggleItalic().run() },
    { label: `Heading 1 (${mod}+Alt+1)`, icon: <Heading1 size={16} />, active: state?.h1, disabled: blockTypeDisabled, run: () => editor?.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: `Heading 2 (${mod}+Alt+2)`, icon: <Heading2 size={16} />, active: state?.h2, disabled: blockTypeDisabled, run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: `Heading 3 (${mod}+Alt+3)`, icon: <Heading3 size={16} />, active: state?.h3, disabled: blockTypeDisabled, run: () => editor?.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: `Bullet list (${mod}+Shift+8)`, icon: <List size={16} />, active: state?.bullet, disabled: blockTypeDisabled, run: () => editor?.chain().focus().toggleBulletList().run() },
    { label: `Numbered list (${mod}+Shift+7)`, icon: <ListOrdered size={16} />, active: state?.ordered, disabled: blockTypeDisabled, run: () => editor?.chain().focus().toggleOrderedList().run() },
  ];

  return (
    <div className="border-t border-line" role="toolbar" aria-label="Formatting">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-1 px-3 py-1.5 sm:px-4">
        {items.map((it) => (
          <Tip key={it.label} label={it.label}>
            <Button variant="ghost" size="icon" active={!!it.active} disabled={disabled || !!it.disabled} onClick={it.run} aria-label={it.label}>
              {it.icon}
            </Button>
          </Tip>
        ))}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <Tip label="Insert image">
          <Button variant="ghost" size="icon" disabled={disabled || !uploads} onClick={() => fileRef.current?.click()} aria-label="Insert image">
            <ImageIcon size={16} />
          </Button>
        </Tip>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            if (e.target.files?.length) onPickFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <Tip label={`Undo (${mod}+Z)`}>
          <Button variant="ghost" size="icon" disabled={!editor || !state?.canUndo} onClick={() => editor?.chain().focus().undo().run()} aria-label="Undo">
            <Undo2 size={16} />
          </Button>
        </Tip>
        <Tip label={`Redo (${mod}+Shift+Z)`}>
          <Button variant="ghost" size="icon" disabled={!editor || !state?.canRedo} onClick={() => editor?.chain().focus().redo().run()} aria-label="Redo">
            <Redo2 size={16} />
          </Button>
        </Tip>
        {lockName && (
          <span className="ml-auto text-[12px] text-muted" role="status">
            {lockName} is writing here too
          </span>
        )}
      </div>
    </div>
  );
}

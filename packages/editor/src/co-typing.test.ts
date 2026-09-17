import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Editor } from '@tiptap/core';
import { Awareness } from 'y-protocols/awareness';
import { createCollabEditorExtensions } from './extensions';
import { LockManager } from './soft-lock';

/**
 * Regression guard for the core promise of the product: two people typing in the SAME paragraph
 * at the same time, with updates crossing after every keystroke.
 *
 * @tiptap/y-tiptap 3.0.6+ "recovers" the local caret after each remote update whenever the
 * paragraph's text changed, snapping it back to its old numeric offset. With someone typing earlier
 * in the paragraph that offset is one character short, so every new letter lands in front of the
 * previous one and the author's text comes out reversed ("ALICE" → "ECILA"). The workspace pins
 * 3.0.5 (see `pnpm.overrides`). If this test fails after a dependency bump, that is the cause.
 */
function make(userId: string) {
  const ydoc = new Y.Doc();
  const manager = new LockManager({ userId, canLock: () => true, rpc: () => null });
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: createCollabEditorExtensions({
      ydoc,
      provider: { awareness: new Awareness(ydoc) },
      user: { id: userId, name: userId, color: '#000' },
      lockManager: manager,
      carets: false,
    }),
  });
  return { editor, ydoc, manager };
}

function pair(html: string) {
  const A = make('alice');
  const B = make('bob');
  A.editor.commands.setContent(html);
  const sync = () => {
    Y.applyUpdate(B.ydoc, Y.encodeStateAsUpdate(A.ydoc, Y.encodeStateVector(B.ydoc)), 'remote');
    Y.applyUpdate(A.ydoc, Y.encodeStateAsUpdate(B.ydoc, Y.encodeStateVector(A.ydoc)), 'remote');
  };
  sync();
  return { A, B, sync };
}

/** Type one character at a time on alternating sides, syncing after every keystroke. */
function interleave(p: ReturnType<typeof pair>, a: string, b: string) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) p.A.editor.commands.insertContent(a[i]!);
    p.sync();
    if (b[i]) p.B.editor.commands.insertContent(b[i]!);
    p.sync();
  }
}

describe('co-typing in one paragraph', () => {
  it('keeps each author in order when the other types EARLIER in the paragraph', () => {
    const p = pair('<p data-block-id="blockAAAAAAA">hello world and more text here</p>');
    p.A.editor.commands.setTextSelection(12); // after "hello world"
    p.B.editor.commands.setTextSelection(1); // very start
    interleave(p, 'ALICE', 'BOB__');
    const text = p.A.editor.state.doc.textContent;
    expect(p.B.editor.state.doc.textContent).toBe(text);
    expect(text).toBe('BOB__hello worldALICE and more text here');
  });

  it('keeps each author in order when the other types LATER in the paragraph', () => {
    const p = pair('<p data-block-id="blockAAAAAAA">hello world and more text here</p>');
    p.A.editor.commands.setTextSelection(1);
    p.B.editor.commands.setTextSelection(12);
    interleave(p, 'alice-first', 'bob-second');
    const text = p.A.editor.state.doc.textContent;
    expect(p.B.editor.state.doc.textContent).toBe(text);
    expect(text).toBe('alice-firsthello worldbob-second and more text here');
  });

  it('works while each side believes the other holds the paragraph (worst case for the soft lock)', () => {
    const p = pair('<p data-block-id="blockAAAAAAA">shared sentence</p>');
    const holder = (userId: string, name: string) => ({ userId, clientId: 'c', name, color: '#f00', expiresAt: Date.now() + 30_000 });
    p.A.manager.applyLockChanged({ blockId: 'blockAAAAAAA', holder: holder('bob', 'Bob') });
    p.B.manager.applyLockChanged({ blockId: 'blockAAAAAAA', holder: holder('alice', 'Alice') });
    p.A.editor.commands.setTextSelection(7); // after "shared"
    p.B.editor.commands.setTextSelection(16); // end
    interleave(p, '-AAA', '-BBB');
    const text = p.A.editor.state.doc.textContent;
    expect(p.B.editor.state.doc.textContent).toBe(text);
    expect(text).toBe('shared-AAA sentence-BBB');
  });

  it('two carets at the SAME spot still converge, with both words intact', () => {
    const p = pair('<p data-block-id="blockAAAAAAA">start end</p>');
    p.A.editor.commands.setTextSelection(6);
    p.B.editor.commands.setTextSelection(6);
    interleave(p, 'AAAA', 'BBBB');
    const text = p.A.editor.state.doc.textContent;
    expect(p.B.editor.state.doc.textContent).toBe(text);
    expect(text.replace(/[^A]/g, '')).toBe('AAAA');
    expect(text.replace(/[^B]/g, '')).toBe('BBBB');
    expect(text.startsWith('start')).toBe(true);
    expect(text.endsWith(' end')).toBe(true);
  });
});

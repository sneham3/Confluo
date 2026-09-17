import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Editor } from '@tiptap/core';
import { Awareness } from 'y-protocols/awareness';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { CONTENT_FIELD } from '@confluo/shared';
import { createCollabEditorExtensions } from './extensions';
import { LockManager, blocksInRange, transactionBlocks } from './soft-lock';

function makeEditor(userId = 'me', onBlocked = vi.fn()) {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const manager = new LockManager({
    userId,
    canLock: () => true,
    rpc: () => null,
    onBlocked,
  });
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createCollabEditorExtensions({
      ydoc,
      provider: { awareness },
      user: { id: userId, name: 'Me', color: '#000' },
      lockManager: manager,
      carets: false,
    }),
  });
  editor.commands.setContent('<p data-block-id="blockAAAAAAA">first</p><p data-block-id="blockBBBBBBB">second</p>');
  return { editor, manager, ydoc, onBlocked };
}

function blockIds(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.forEach((n) => ids.push(n.attrs.blockId as string));
  return ids;
}

describe('soft lock plugin', () => {
  it('assigns block ids and computes blocks in ranges', () => {
    const { editor } = makeEditor();
    const ids = blockIds(editor);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    const doc = editor.state.doc;
    expect(blocksInRange(doc, 2, 2)).toEqual([ids[0]]);
    expect(blocksInRange(doc, 2, doc.content.size - 1)).toEqual(ids);
  });

  it('blocks local edits inside a block held by someone else, allows others', () => {
    const { editor, manager, onBlocked } = makeEditor();
    const [a, b] = blockIds(editor) as [string, string];
    manager.applyLockChanged({
      blockId: a,
      holder: { userId: 'other', clientId: 'c1', name: 'Other', color: '#f00', expiresAt: Date.now() + 30_000 },
    });
    // Edit inside first block → dropped by filterTransaction (commands still report true)
    const secondBlockPos = editor.state.doc.child(0).nodeSize + 1;
    editor.chain().setTextSelection(1).insertContent("X").run();
    expect(onBlocked).toHaveBeenCalled();
    expect(editor.state.doc.child(0).textContent).toBe('first');
    // Edit inside second block → allowed
    editor.chain().setTextSelection(secondBlockPos).insertContent("Y").run();
    expect(editor.state.doc.child(1).textContent).toBe('Ysecond');
    // Deleting across the boundary into the locked block → dropped
    editor.chain().setTextSelection({ from: 3, to: secondBlockPos + 2 }).deleteSelection().run();
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(0).textContent).toBe('first');
    expect(editor.state.doc.child(1).attrs.blockId).toBe(b);
  });

  it('decorates locked blocks and clears when released', () => {
    const { editor, manager } = makeEditor();
    const [a] = blockIds(editor) as [string, string];
    manager.applyLockChanged({
      blockId: a,
      holder: { userId: 'other', clientId: 'c1', name: 'Other', color: '#f00', expiresAt: Date.now() + 30_000 },
    });
    expect(editor.view.dom.querySelector('.is-locked')).not.toBeNull();
    expect(editor.view.dom.querySelector('.is-locked')?.getAttribute('data-lock-name')).toBe('Other');
    manager.applyLockChanged({ blockId: a, holder: null });
    expect(editor.view.dom.querySelector('.is-locked')).toBeNull();
  });

  it('never blocks remote (y-sync) transactions', () => {
    const { editor, manager, ydoc } = makeEditor();
    const [a] = blockIds(editor) as [string, string];
    manager.applyLockChanged({
      blockId: a,
      holder: { userId: 'other', clientId: 'c1', name: 'Other', color: '#f00', expiresAt: Date.now() + 30_000 },
    });
    // Simulate the holder editing remotely by applying a Yjs update from another doc.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc));
    const frag = other.getXmlFragment(CONTENT_FIELD);
    const first = frag.get(0) as Y.XmlElement;
    (first.get(0) as Y.XmlText).insert(0, 'REMOTE ');
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(ydoc)));
    expect(editor.state.doc.child(0).textContent).toBe('REMOTE first');
    expect(ySyncPluginKey.getState(editor.state)).toBeTruthy();
  });

  it('ignores our own locks and computes transaction blocks', () => {
    const { editor, manager } = makeEditor('me');
    const [a] = blockIds(editor) as [string, string];
    manager.applyLockChanged({
      blockId: a,
      holder: { userId: 'me', clientId: 'c9', name: 'Me', color: '#000', expiresAt: Date.now() + 30_000 },
    });
    expect(manager.isLockedByOther(a)).toBe(false);
    const tr = editor.state.tr.insertText('Z', 2);
    expect([...transactionBlocks(tr)]).toEqual([a]);
    editor.chain().setTextSelection(1).insertContent("Z").run();
    expect(editor.state.doc.child(0).textContent).toBe('Zfirst');
  });
});

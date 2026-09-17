import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Editor } from '@tiptap/core';
import { Awareness } from 'y-protocols/awareness';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { CONTENT_FIELD } from '@confluo/shared';
import { createCollabEditorExtensions } from './extensions';
import { LockManager, blocksInRange, transactionBlocks, transactionDamagedBlocks } from './soft-lock';

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

  it('lets everyone type inside a block held by someone else (co-editing)', () => {
    const { editor, manager, onBlocked } = makeEditor();
    const [a] = blockIds(editor) as [string, string];
    manager.applyLockChanged({
      blockId: a,
      holder: { userId: 'other', clientId: 'c1', name: 'Other', color: '#f00', expiresAt: Date.now() + 30_000 },
    });
    // Typing, deleting text and marks inside the held paragraph all go through.
    editor.chain().setTextSelection(1).insertContent('X').run();
    expect(editor.state.doc.child(0).textContent).toBe('Xfirst');
    editor.chain().setTextSelection({ from: 1, to: 2 }).deleteSelection().run();
    expect(editor.state.doc.child(0).textContent).toBe('first');
    editor.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();
    expect(editor.state.doc.child(0).firstChild?.marks.some((m) => m.type.name === 'bold')).toBe(true);
    // Enter splits it normally; the holder's element survives with its id.
    editor.chain().setTextSelection(3).splitBlock().run();
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(0).attrs.blockId).toBe(a);
    expect(editor.state.doc.child(0).textContent + editor.state.doc.child(1).textContent).toBe('first');
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it('refuses only operations that would destroy a block someone else is writing in', () => {
    const { editor, manager, onBlocked } = makeEditor();
    const [a, b] = blockIds(editor) as [string, string];
    manager.applyLockChanged({
      blockId: a,
      holder: { userId: 'other', clientId: 'c1', name: 'Other', color: '#f00', expiresAt: Date.now() + 30_000 },
    });
    const secondBlockPos = editor.state.doc.child(0).nodeSize + 1;

    // Deleting across the boundary into the held block → refused.
    editor.chain().setTextSelection({ from: 3, to: secondBlockPos + 2 }).deleteSelection().run();
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(0).textContent).toBe('first');
    expect(editor.state.doc.child(1).textContent).toBe('second');
    expect(onBlocked).toHaveBeenCalledTimes(1);

    // Re-typing the held paragraph as a heading replaces its Yjs element → refused.
    editor.chain().setTextSelection(2).toggleHeading({ level: 1 }).run();
    expect(editor.state.doc.child(0).type.name).toBe('paragraph');

    // Backspace at the start of the next block would join it into the held one → refused.
    editor.chain().setTextSelection(secondBlockPos).joinBackward().run();
    expect(editor.state.doc.childCount).toBe(2);

    // Deleting the held block outright → refused.
    editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.child(0).nodeSize));
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(0).attrs.blockId).toBe(a);

    // The free block is fully editable, including restyling.
    editor.chain().setTextSelection(secondBlockPos).insertContent('Y').run();
    expect(editor.state.doc.child(1).textContent).toBe('Ysecond');
    editor.chain().setTextSelection(secondBlockPos).toggleHeading({ level: 2 }).run();
    expect(editor.state.doc.child(1).type.name).toBe('heading');
    expect(editor.state.doc.child(1).attrs.blockId).toBe(b);
  });

  it('classifies damage: inside-content edits are safe, boundary-crossing edits are not', () => {
    const { editor } = makeEditor();
    const [a, b] = blockIds(editor) as [string, string];
    const size = editor.state.doc.child(0).nodeSize;
    expect([...transactionDamagedBlocks(editor.state.tr.insertText('Z', 2))]).toEqual([]);
    expect([...transactionDamagedBlocks(editor.state.tr.delete(1, size - 1))]).toEqual([]); // all text, block kept
    expect([...transactionDamagedBlocks(editor.state.tr.split(3))]).toEqual([]);
    expect([...transactionDamagedBlocks(editor.state.tr.delete(0, size))]).toEqual([a]);
    expect(new Set(transactionDamagedBlocks(editor.state.tr.delete(3, size + 3)))).toEqual(new Set([a, b]));
    expect([...transactionDamagedBlocks(editor.state.tr.setNodeMarkup(0, editor.schema.nodes.heading, { level: 1, blockId: a }))]).toEqual([a]);
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

  it('two people typing in the same paragraph at once converge with nothing lost', () => {
    const A = makeEditor('alice');
    const B = makeEditor('bob');
    // Same starting document on both sides.
    Y.applyUpdate(B.ydoc, Y.encodeStateAsUpdate(A.ydoc));
    Y.applyUpdate(A.ydoc, Y.encodeStateAsUpdate(B.ydoc));
    const sync = () => {
      Y.applyUpdate(B.ydoc, Y.encodeStateAsUpdate(A.ydoc, Y.encodeStateVector(B.ydoc)));
      Y.applyUpdate(A.ydoc, Y.encodeStateAsUpdate(B.ydoc, Y.encodeStateVector(A.ydoc)));
    };
    sync();
    const targetIndex = (e: Editor) => {
      let idx = -1;
      e.state.doc.forEach((n, _o, i) => {
        if (idx < 0 && n.textContent.includes('first')) idx = i;
      });
      return idx;
    };
    const posIn = (e: Editor, atEnd: boolean) => {
      let pos = 0;
      const i = targetIndex(e);
      e.state.doc.forEach((n, offset, index) => {
        if (index === i) pos = atEnd ? offset + n.nodeSize - 1 : offset + 1;
      });
      return pos;
    };
    const id = A.editor.state.doc.child(targetIndex(A.editor)).attrs.blockId as string;
    // Each side believes the other holds this paragraph: worst case for the lock.
    A.manager.applyLockChanged({ blockId: id, holder: { userId: 'bob', clientId: 'cb', name: 'Bob', color: '#00f', expiresAt: Date.now() + 30_000 } });
    B.manager.applyLockChanged({ blockId: id, holder: { userId: 'alice', clientId: 'ca', name: 'Alice', color: '#f00', expiresAt: Date.now() + 30_000 } });

    // Interleaved keystrokes with no sync in between (a slow network), then merge.
    for (const ch of 'AAAA') A.editor.chain().setTextSelection(posIn(A.editor, false)).insertContent(ch).run();
    for (const ch of 'BBBB') B.editor.chain().setTextSelection(posIn(B.editor, true)).insertContent(ch).run();
    sync();

    const textA = A.editor.state.doc.child(targetIndex(A.editor)).textContent;
    const textB = B.editor.state.doc.child(targetIndex(B.editor)).textContent;
    expect(textA).toBe(textB);
    expect(textA).toContain('first');
    expect(textA.match(/A/g)?.length).toBe(4);
    expect(textA.match(/B/g)?.length).toBe(4);
    expect(A.onBlocked).not.toHaveBeenCalled();
    expect(B.onBlocked).not.toHaveBeenCalled();
  });

  it('claims nothing just because the document is open, and releases when idle', async () => {
    vi.useFakeTimers();
    try {
      const acquire = vi.fn(async () => ({ granted: true, holder: null, expiresAt: Date.now() + 30_000 }));
      const release = vi.fn(async () => undefined);
      const manager = new LockManager({
        userId: 'me',
        canLock: () => true,
        rpc: () => ({ acquire, release, heartbeat: async () => ({ renewed: [], lost: [] }) }),
      });
      // Opening a document (no focus, no activity) must not claim any block.
      expect(manager.isActive()).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(acquire).not.toHaveBeenCalled();

      // Activity + a selection inside a block → claim.
      manager.markActivity();
      manager.setSelectionBlocks(['blockAAAAAAA']);
      await vi.advanceTimersByTimeAsync(50);
      expect(acquire).toHaveBeenCalledWith('blockAAAAAAA');
      expect(manager.held.has('blockAAAAAAA')).toBe(true);

      // Four idle seconds → released for everyone else.
      await vi.advanceTimersByTimeAsync(4_100);
      expect(release).toHaveBeenCalledWith('blockAAAAAAA');
      expect(manager.held.size).toBe(0);
      expect(manager.isActive()).toBe(false);

      // Next keystroke re-takes it.
      manager.markActivity();
      manager.setSelectionBlocks(['blockAAAAAAA']);
      await vi.advanceTimersByTimeAsync(50);
      expect(acquire).toHaveBeenCalledTimes(2);
      manager.destroy();
    } finally {
      vi.useRealTimers();
    }
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

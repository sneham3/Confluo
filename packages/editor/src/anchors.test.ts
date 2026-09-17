import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Editor } from '@tiptap/core';
import { Awareness } from 'y-protocols/awareness';
import { CONTENT_FIELD } from '@confluo/shared';
import { createCollabEditorExtensions } from './extensions';
import { anchorFromSelection, blockRange, resolveAnchor } from './anchors';

function makeEditor() {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createCollabEditorExtensions({
      ydoc,
      provider: { awareness },
      user: { id: 'u', name: 'U', color: '#000' },
      carets: false,
    }),
  });
  editor.commands.setContent('<p>hello world</p><p>second</p>');
  return { editor, ydoc };
}

describe('comment anchors', () => {
  it('encodes a selection and resolves it back', () => {
    const { editor } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 12 }); // "world"
    const anchor = anchorFromSelection(editor)!;
    expect(anchor).not.toBeNull();
    expect(anchor.blockId).toBeTruthy();
    const range = resolveAnchor(editor, anchor)!;
    expect(editor.state.doc.textBetween(range.from, range.to)).toBe('world');
  });

  it('keeps pointing at the same text after concurrent inserts before it', () => {
    const { editor, ydoc } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 12 });
    const anchor = anchorFromSelection(editor)!;
    // Remote insert at the beginning of the paragraph.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc));
    const frag = other.getXmlFragment(CONTENT_FIELD);
    ((frag.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'AAAA ');
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(ydoc)));
    expect(editor.state.doc.child(0).textContent).toBe('AAAA hello world');
    const range = resolveAnchor(editor, anchor)!;
    expect(editor.state.doc.textBetween(range.from, range.to)).toBe('world');
  });

  it('returns null when the anchored text was removed, and blockRange works as fallback', () => {
    const { editor } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 12 });
    const anchor = anchorFromSelection(editor)!;
    editor.chain().setTextSelection({ from: 1, to: 12 }).deleteSelection().run();
    const range = resolveAnchor(editor, anchor);
    // Either unresolvable or collapsed; both mean "original text removed".
    expect(range === null || range.from === range.to).toBe(true);
    const secondId = editor.state.doc.child(1).attrs.blockId as string;
    const br = blockRange(editor, secondId)!;
    expect(editor.state.doc.textBetween(br.from, br.to)).toBe('second');
  });
});

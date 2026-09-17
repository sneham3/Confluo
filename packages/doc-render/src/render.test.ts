import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createInitialDoc, encodeSnapshot, sanitizeHTML, stats, toHTML, toProseMirrorJSON, toText } from './index.js';

describe('doc-render', () => {
  it('creates an initial doc with one paragraph carrying a blockId', () => {
    const ydoc = createInitialDoc('11111111-1111-1111-1111-111111111111');
    const json = toProseMirrorJSON(ydoc);
    expect(json.content?.length).toBe(1);
    expect(json.content?.[0]?.type).toBe('paragraph');
    expect(typeof json.content?.[0]?.attrs?.blockId).toBe('string');
    expect(toHTML(ydoc)).toContain('data-block-id=');
    expect(toText(ydoc)).toBe('');
  });

  it('round-trips a snapshot', () => {
    const ydoc = createInitialDoc('22222222-2222-2222-2222-222222222222');
    const frag = ydoc.getXmlFragment('content');
    const p = frag.get(0) as Y.XmlElement;
    p.insert(0, [new Y.XmlText('hello world')]);
    const snap = encodeSnapshot(ydoc);
    const copy = new Y.Doc();
    Y.applyUpdateV2(copy, snap.state);
    expect(toText(copy)).toBe('hello world');
    expect(stats(copy).chars).toBe(11);
  });

  it('sanitizes disallowed tags and handlers', () => {
    expect(sanitizeHTML('<p onclick="x()">a</p><script>1</script><img src="javascript:alert(1)">')).toBe(
      '<p>a</p>1<img>',
    );
  });
});

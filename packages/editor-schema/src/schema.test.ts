import { describe, expect, it } from 'vitest';
import { generateHTML, generateJSON } from '@tiptap/html';
import { createSchemaExtensions } from './index.js';

const fixture = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1, blockId: 'h1aaaaaaaaaa' }, content: [{ type: 'text', text: 'Title' }] },
    {
      type: 'paragraph',
      attrs: { blockId: 'p1aaaaaaaaaa' },
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', marks: [{ type: 'bold' }], text: 'bold' },
        { type: 'text', text: ' and ' },
        { type: 'text', marks: [{ type: 'italic' }], text: 'italic' },
      ],
    },
    {
      type: 'bulletList',
      attrs: { blockId: 'l1aaaaaaaaaa' },
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
      ],
    },
    {
      type: 'image',
      attrs: { src: 'https://x/y.png', alt: 'pic', assetId: 'a1', status: 'ready', width: 300, blockId: 'i1aaaaaaaaaa' },
    },
  ],
};

describe('editor schema', () => {
  it('renders HTML with block ids and survives a round trip', () => {
    const ext = createSchemaExtensions();
    const html = generateHTML(fixture, ext);
    expect(html).toContain('data-block-id="h1aaaaaaaaaa"');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<figure data-type="image"');
    expect(html).toContain('src="https://x/y.png"');
    const json = generateJSON(html, ext) as typeof fixture;
    expect(json.content[0]?.attrs).toMatchObject({ level: 1, blockId: 'h1aaaaaaaaaa' });
    expect(json.content[3]?.type).toBe('image');
  });

  it('drops unknown/dangerous HTML', () => {
    const ext = createSchemaExtensions();
    const json = generateJSON('<p>ok</p><script>alert(1)</script><iframe src="x"></iframe>', ext);
    const html = generateHTML(json, ext);
    expect(html).not.toContain('script');
    expect(html).not.toContain('iframe');
  });

  it('never emits blob: urls', () => {
    const ext = createSchemaExtensions();
    const html = generateHTML(
      { type: 'doc', content: [{ type: 'image', attrs: { src: 'blob:http://x/1', alt: '', status: 'uploading' } }] },
      ext,
    );
    expect(html).not.toContain('blob:');
  });
});

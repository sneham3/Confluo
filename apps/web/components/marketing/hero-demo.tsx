'use client';

import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { EditorContent, useEditor } from '@tiptap/react';
import { Awareness, createCollabEditorExtensions, LockManager } from '@confluo/editor';
import { CONTENT_FIELD } from '@confluo/shared';
import { track } from '@/lib/analytics';

const PERSONAS = [
  { id: 'maya', name: 'Maya', color: '#B23A3A' },
  { id: 'jonas', name: 'Jonas', color: '#2447F5' },
] as const;

type Pill = 'synced' | 'offline' | 'reconnecting';

/**
 * Real TipTap editor on a local Y.Doc. Two scripted collaborators type into their own
 * paragraphs (applied as Yjs updates, exactly like remote edits) while holding soft locks.
 * Visitors can click in and type themselves.
 */
export function HeroDemo() {
  const ydocRef = useRef<Y.Doc | null>(null);
  const managerRef = useRef<LockManager | null>(null);
  const [pill, setPill] = useState<Pill>('synced');
  const [typed, setTyped] = useState(false);

  if (!ydocRef.current) {
    const ydoc = new Y.Doc();
    const frag = ydoc.getXmlFragment(CONTENT_FIELD);
    const mk = (tag: string, text: string, attrs: Record<string, string>) => {
      const el = new Y.XmlElement(tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      el.insert(0, [new Y.XmlText(text)]);
      return el;
    };
    frag.insert(0, [
      mk('heading', 'Launch notes', { level: '2', blockId: 'demo-heading' }),
      mk('paragraph', 'Maya is drafting the summary here. ', { blockId: 'demo-maya' }),
      mk('paragraph', 'Jonas is listing the risks in this paragraph. ', { blockId: 'demo-jonas' }),
      mk('paragraph', 'This paragraph is yours: click and type.', { blockId: 'demo-you' }),
    ]);
    ydocRef.current = ydoc;
    managerRef.current = new LockManager({ userId: 'you', canLock: () => false, rpc: () => null });
  }

  const editor = useEditor({
    extensions: createCollabEditorExtensions({
      ydoc: ydocRef.current,
      provider: { awareness: new Awareness(ydocRef.current) },
      user: { id: 'you', name: 'You', color: '#0F6E6E' },
      lockManager: managerRef.current!,
      carets: false,
    }),
    editorProps: { attributes: { class: 'confluo-editor', 'aria-label': 'Demo editor: try typing' } },
    immediatelyRender: false,
    onUpdate: () => {
      if (!typed) {
        setTyped(true);
        track('demo_interact');
      }
    },
  });

  // Scripted loop: 14 s, pauses when the tab is hidden.
  useEffect(() => {
    const ydoc = ydocRef.current!;
    const manager = managerRef.current!;
    const frag = ydoc.getXmlFragment(CONTENT_FIELD);
    const lines = {
      maya: ['We shipped conflict-free merging, ', 'so nobody overwrites anyone. '],
      jonas: ['Risk: flaky Wi-Fi on the train. ', 'Mitigation: offline-first sync. '],
    };
    let stopped = false;
    let step = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

    const findText = (blockId: string): Y.XmlText | null => {
      for (let i = 0; i < frag.length; i++) {
        const el = frag.get(i);
        if (el instanceof Y.XmlElement && el.getAttribute('blockId') === blockId) {
          const t = el.get(0);
          return t instanceof Y.XmlText ? t : null;
        }
      }
      return null;
    };
    const lock = (persona: (typeof PERSONAS)[number], blockId: string, on: boolean) =>
      manager.applyLockChanged({
        blockId,
        holder: on ? { userId: persona.id, clientId: persona.id, name: persona.name, color: persona.color, expiresAt: Date.now() + 60_000 } : null,
      });
    const typeInto = (blockId: string, text: string, delay: number, done: () => void) => {
      let i = 0;
      const tick = () => {
        if (stopped) return;
        if (document.hidden) {
          later(500, tick);
          return;
        }
        const t = findText(blockId);
        if (!t) return done();
        t.insert(t.length, text[i]!);
        i++;
        if (i < text.length) later(delay, tick);
        else done();
      };
      tick();
    };

    const cycle = () => {
      if (stopped) return;
      const round = step % 2;
      step++;
      lock(PERSONAS[0], 'demo-maya', true);
      later(400, () => lock(PERSONAS[1], 'demo-jonas', true));
      typeInto('demo-maya', lines.maya[round]!, 45, () => later(600, () => lock(PERSONAS[0], 'demo-maya', false)));
      later(300, () => typeInto('demo-jonas', lines.jonas[round]!, 55, () => later(600, () => lock(PERSONAS[1], 'demo-jonas', false))));
      later(5_000, () => setPill('offline'));
      later(7_500, () => setPill('reconnecting'));
      later(9_000, () => setPill('synced'));
      later(14_000, () => {
        // Trim the demo paragraphs so the loop does not grow forever.
        for (const id of ['demo-maya', 'demo-jonas']) {
          const t = findText(id);
          if (t && t.length > 120) t.delete(40, t.length - 40);
        }
        cycle();
      });
    };
    later(800, cycle);
    return () => {
      stopped = true;
      timers.forEach(clearTimeout);
    };
  }, []);

  useEffect(() => () => managerRef.current?.destroy(), []);

  const pillStyle: Record<Pill, string> = {
    synced: 'bg-success/15 text-success',
    offline: 'bg-code-bg text-muted',
    reconnecting: 'bg-warning/15 text-warning',
  };
  const pillLabel: Record<Pill, string> = { synced: 'Synced', offline: 'Offline — saved on this device', reconnecting: 'Reconnecting…' };

  return (
    <div className="demo-editor rounded-lg border border-line bg-surface shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2">
          {PERSONAS.map((p) => (
            <span key={p.id} className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold text-white" style={{ background: p.color }} aria-hidden>
              {p.name[0]}
            </span>
          ))}
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-on-accent" aria-hidden>
            Y
          </span>
          <span className="ml-1 text-[12px] text-muted">Maya, Jonas and you</span>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[12px] font-medium ${pillStyle[pill]}`} role="status" aria-live="polite">
          {pillLabel[pill]}
        </span>
      </div>
      <div className="px-5 py-4">
        <p className="sr-only">
          A live demo editor. Two simulated collaborators type into their own paragraphs while the paragraphs they edit show a lock chip with their name. You can type in the last paragraph.
        </p>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

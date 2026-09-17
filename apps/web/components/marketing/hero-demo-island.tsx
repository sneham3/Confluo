'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

const HeroDemo = dynamic(() => import('./hero-demo').then((m) => m.HeroDemo), {
  ssr: false,
  loading: () => <DemoSkeleton />,
});

function DemoSkeleton() {
  return (
    <div className="h-[340px] w-full rounded-lg border border-line bg-surface p-5" aria-hidden>
      <div className="mb-4 flex gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-line" />
        <span className="h-2.5 w-2.5 rounded-full bg-line" />
        <span className="h-2.5 w-2.5 rounded-full bg-line" />
      </div>
      <div className="space-y-3">
        <div className="h-5 w-2/3 rounded bg-code-bg" />
        <div className="h-4 w-full rounded bg-code-bg" />
        <div className="h-4 w-5/6 rounded bg-code-bg" />
        <div className="h-4 w-4/6 rounded bg-code-bg" />
      </div>
    </div>
  );
}

/** Mounts the live demo only after the page is idle so it never competes with LCP. */
export function HeroDemoIsland() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(() => setReady(true), { timeout: 1500 });
    else setTimeout(() => setReady(true), 300);
  }, []);
  return ready ? <HeroDemo /> : <DemoSkeleton />;
}

'use client';

import { useEffect, useRef } from 'react';

/**
 * Topographic line art for the hero: nested organic contours with a purple→blue gradient stroke.
 *
 * The base shape is generated deterministically at module load (seeded), so server and client render
 * identical markup. On the client the rings then wobble: a slow idle undulation the whole time, plus a
 * stronger ripple around the cursor that builds while it moves and settles when it stops. Nothing is
 * translated toward the pointer; the geometry itself flexes. Disabled under prefers-reduced-motion.
 */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

interface BlobSpec {
  cx: number;
  cy: number;
  radius: number;
  rings: number;
  seed: number;
  /** How far each inner ring's centre drifts, giving the contour-map lean. */
  drift: [number, number];
}

interface Ring {
  x0: number;
  y0: number;
  r0: number;
  /** Static radius multiplier per sample angle (the ring's resting shape). */
  base: Float32Array;
  /** Per-ring wobble phases so neighbours don't move in lockstep. */
  phase: [number, number];
}

const POINTS = 120;
const ANGLES = Float32Array.from({ length: POINTS + 1 }, (_, i) => (i / POINTS) * Math.PI * 2);

function buildRings({ cx, cy, radius, rings, seed, drift }: BlobSpec): Ring[] {
  const rnd = seeded(seed);
  const harmonics = [1, 2, 3, 5].map((h, i) => ({
    h,
    amp: [0.2, 0.13, 0.07, 0.03][i]! * (0.7 + rnd() * 0.6),
    phase: rnd() * Math.PI * 2,
    twist: (rnd() - 0.5) * 0.35,
  }));
  const out: Ring[] = [];
  for (let k = 0; k < rings; k++) {
    const t = k / (rings - 1); // 0 = outermost, 1 = innermost
    const base = new Float32Array(POINTS + 1);
    for (let i = 0; i <= POINTS; i++) {
      const th = ANGLES[i]!;
      let m = 1;
      for (const { h, amp, phase, twist } of harmonics) m += amp * (1 - t * 0.45) * Math.sin(h * th + phase + twist * k);
      base[i] = m;
    }
    out.push({
      x0: cx + drift[0] * t,
      y0: cy + drift[1] * t,
      r0: radius * (1 - t * 0.9),
      base,
      phase: [rnd() * Math.PI * 2, rnd() * Math.PI * 2],
    });
  }
  return out;
}

/** Path data for one ring. `wobble` is the extra radius multiplier amplitude; `time` in seconds. */
function ringPath(ring: Ring, time: number, wobble: number): string {
  const { x0, y0, r0, base, phase } = ring;
  let d = '';
  for (let i = 0; i <= POINTS; i++) {
    const th = ANGLES[i]!;
    let m = base[i]!;
    if (wobble > 0) {
      m +=
        wobble * Math.sin(3 * th + time * 1.6 + phase[0]) +
        wobble * 0.55 * Math.sin(5 * th - time * 2.3 + phase[1]) +
        wobble * 0.3 * Math.sin(8 * th + time * 3.1 + phase[0] * 0.5);
    }
    const r = r0 * m;
    d += (i === 0 ? 'M' : 'L') + (x0 + r * Math.cos(th)).toFixed(1) + ' ' + (y0 + r * Math.sin(th)).toFixed(1);
  }
  return d + 'Z';
}

const BLOBS: BlobSpec[] = [
  { cx: 265, cy: 250, radius: 225, rings: 13, seed: 7, drift: [-18, 40] },
  { cx: 590, cy: 540, radius: 250, rings: 12, seed: 23, drift: [30, -22] },
];
const RINGS = BLOBS.map(buildRings);
const STATIC_PATHS = RINGS.map((rings) => rings.map((r) => ringPath(r, 0, 0)));

const IDLE_WOBBLE = 0.012; // always-on breathing
const HOVER_WOBBLE = 0.075; // extra amplitude at the cursor, at full energy
const HOVER_RADIUS = 260; // viewBox units; how far the ripple reaches from the cursor

function useWobble(svgRef: React.RefObject<SVGSVGElement | null>) {
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const host: Element = svg.closest('section') ?? svg;
    const paths = RINGS.map((_, b) => Array.from(svg.querySelectorAll<SVGPathElement>(`g[data-blob="${b}"] path`)));

    // Cursor in viewBox coordinates (null when not over the hero).
    let cursor: { x: number; y: number } | null = null;
    let last: { x: number; y: number; t: number } | null = null;
    let energy = 0; // 0..1, builds with cursor movement, decays when still or absent
    let visible = true;
    let raf = 0;
    const start = performance.now();
    let prev = start;

    const toViewBox = (clientX: number, clientY: number) => {
      const r = svg.getBoundingClientRect();
      // preserveAspectRatio="xMidYMid meet": uniform scale, centred.
      const scale = Math.min(r.width / 720, r.height / 620);
      const ox = r.left + (r.width - 720 * scale) / 2;
      const oy = r.top + (r.height - 620 * scale) / 2;
      return { x: (clientX - ox) / scale, y: (clientY - oy) / scale };
    };

    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      const time = (now - start) / 1000;
      // Energy decays toward a resting level that depends on whether the cursor is present.
      const rest = cursor ? 0.35 : 0;
      energy += (rest - energy) * (energy > rest ? 1.8 : 3) * dt;

      RINGS.forEach((rings, b) => {
        const els = paths[b] ?? [];
        rings.forEach((ring, k) => {
          let w = IDLE_WOBBLE;
          if (cursor && energy > 0.001) {
            // Proximity of the cursor to this ring's edge, not just its centre, so outer rings react too.
            const dx = cursor.x - ring.x0;
            const dy = cursor.y - ring.y0;
            const dist = Math.abs(Math.hypot(dx, dy) - ring.r0);
            const prox = Math.exp(-(dist * dist) / (HOVER_RADIUS * HOVER_RADIUS * 0.35));
            w += HOVER_WOBBLE * energy * prox;
          }
          els[k]?.setAttribute('d', ringPath(ring, time, w));
        });
      });

      if (visible) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf && visible) {
        prev = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const p = toViewBox(e.clientX, e.clientY);
      const t = performance.now();
      if (last) {
        const speed = Math.hypot(p.x - last.x, p.y - last.y) / Math.max(1, t - last.t); // viewBox units per ms
        energy = Math.min(1, energy + speed * 0.35);
      }
      last = { x: p.x, y: p.y, t };
      cursor = p;
      kick();
    };
    const onLeave = () => {
      cursor = null;
      last = null;
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        visible = !!entry?.isIntersecting;
        if (visible) kick();
      },
      { threshold: 0.05 },
    );
    io.observe(svg);

    host.addEventListener('pointermove', onMove as EventListener, { passive: true });
    host.addEventListener('pointerleave', onLeave);
    kick();
    return () => {
      host.removeEventListener('pointermove', onMove as EventListener);
      host.removeEventListener('pointerleave', onLeave);
      io.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [svgRef]);
}

export function TopoArt({ className }: { className?: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  useWobble(svgRef);
  return (
    <svg ref={svgRef} viewBox="0 0 720 620" className={className} aria-hidden focusable="false" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="topo-grad" x1="0" y1="0" x2="720" y2="620" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f08de6" />
          <stop offset="0.5" stopColor="#8f6bff" />
          <stop offset="1" stopColor="#3f8cff" />
        </linearGradient>
      </defs>
      {STATIC_PATHS.map((paths, b) => (
        <g key={b} data-blob={b} fill="none" stroke="url(#topo-grad)" strokeWidth="1.5" strokeLinejoin="round">
          {paths.map((d, k) => (
            <path key={k} d={d} opacity={0.3 + (k / (paths.length - 1)) * 0.65} />
          ))}
        </g>
      ))}
    </svg>
  );
}

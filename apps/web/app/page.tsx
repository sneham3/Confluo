import { Jost } from 'next/font/google';
import { Nav } from '@/components/marketing/nav';
import { HeroActions } from '@/components/marketing/hero-actions';
import { HeroDemoIsland } from '@/components/marketing/hero-demo-island';
import { LogoMark } from '@/components/marketing/logo-mark';
import { TopoArt } from '@/components/marketing/topo-art';
import { FeatureGrid, Faq, FinalCta, Footer, HowItWorks, PermissionsTable, ProofStrip } from '@/components/marketing/sections';

const jost = Jost({ subsets: ['latin'], variable: '--font-jost', display: 'swap' });

export default function LandingPage() {
  return (
    <div className={`landing-theme ${jost.variable} min-h-full`}>
      <Nav />
      <main id="main">
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div className="mx-auto grid min-h-[calc(100svh-4rem)] max-w-6xl items-center gap-10 px-4 pb-24 pt-10 lg:grid-cols-[1fr_1.1fr] lg:pb-16">
            {/* Left: headline, share-link input, actions */}
            <div className="relative z-10">
              <h1 className="font-display text-[clamp(3.4rem,9.5vw,7.25rem)] font-bold leading-[0.95] tracking-tight text-white">
                Write together.
                <span className="mt-4 block text-[0.34em] font-light leading-tight tracking-normal text-white/85">Never lose a word.</span>
              </h1>
              <HeroActions />
            </div>

            {/* Right: topographic art with the product blurb over it */}
            <div className="relative min-h-[420px] lg:min-h-[560px]">
              <TopoArt className="pointer-events-none absolute -left-[12%] top-1/2 h-[125%] w-[135%] -translate-y-1/2 select-none" />
              <div className="absolute left-1/2 top-[44%] w-[280px] -translate-x-1/2 -translate-y-1/2 text-center lg:left-auto lg:right-2 lg:translate-x-0">
                <LogoMark size={64} gradient className="mx-auto" />
                <p className="mt-3 font-display text-[2rem] font-light leading-tight text-white">Real-time editor.</p>
                <p className="mx-auto mt-3 text-[13px] leading-relaxed text-white/75">
                  Edits merge conflict-free, everyone sees each other’s cursor, and your work is saved on your device even when the network is not.
                </p>
              </div>
            </div>
          </div>

          <a href="#live" className="scroll-hint" aria-label="Scroll to the live demo">
            <span className="scroll-hint__wheel" />
          </a>
        </section>

        {/* Live demo, kept from the previous hero */}
        <section id="live" className="border-t border-line">
          <div className="mx-auto max-w-4xl px-4 py-20">
            <p className="text-center text-[11px] font-bold uppercase tracking-[0.18em] text-accent">Live demo</p>
            <h2 className="mt-3 text-center font-display text-3xl font-semibold tracking-tight sm:text-4xl">Two people, one document, no conflicts.</h2>
            <p className="mx-auto mt-3 max-w-xl text-center text-muted">Watch two collaborators write at the same time. Click in and type alongside them.</p>
            <div className="mt-10">
              <HeroDemoIsland />
            </div>
          </div>
        </section>

        <ProofStrip />
        <HowItWorks />
        <FeatureGrid />
        <PermissionsTable />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}

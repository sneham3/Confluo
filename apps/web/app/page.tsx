import { Nav } from '@/components/marketing/nav';
import { CtaLink } from '@/components/marketing/cta-link';
import { HeroDemoIsland } from '@/components/marketing/hero-demo-island';
import { FeatureGrid, Faq, FinalCta, Footer, HowItWorks, PermissionsTable, ProofStrip } from '@/components/marketing/sections';

export default function LandingPage() {
  return (
    <>
      <Nav />
      <main id="main">
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-14 lg:grid-cols-[1.05fr_1fr] lg:pt-20">
          <div>
            <p className="text-[13px] font-semibold uppercase tracking-wider text-accent">Real-time collaborative editor</p>
            <h1 className="mt-3 font-display text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">Write together. Never lose a word.</h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted">
              Edits merge conflict-free, everyone sees each other’s cursor, and your work is saved on your device even when the network is not.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <CtaLink location="hero">Start writing — free</CtaLink>
              <CtaLink location="hero" secondary href="/login">
                Log in
              </CtaLink>
            </div>
            <p className="mt-4 text-[13px] text-muted">No credit card. Invite collaborators with a link.</p>
          </div>
          <div>
            <HeroDemoIsland />
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
    </>
  );
}

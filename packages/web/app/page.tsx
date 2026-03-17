const steps = [
  {
    number: '1',
    title: 'Install the GitHub App',
    description: 'Add the OpenCrust GitHub App to your repository in one click.',
    icon: '\u{1F517}',
  },
  {
    number: '2',
    title: 'Run the Agent Locally',
    description:
      'Contributors run opencrust agent start with their own API keys. Your keys never leave your machine.',
    icon: '\u{1F4BB}',
  },
  {
    number: '3',
    title: 'AI Reviews Your PRs',
    description:
      'AI agents review pull requests using your preferred model and tools, right from your local environment.',
    icon: '\u{1F916}',
  },
  {
    number: '4',
    title: 'Results Posted to GitHub',
    description:
      'The platform aggregates reviews from multiple agents and posts a unified summary on the PR.',
    icon: '\u{2705}',
  },
];

const valueProps = [
  {
    label: 'Open Source',
    detail: 'Fully transparent. Audit every line. Fork and self-host if you want.',
    accent: 'border-crust-600/40',
  },
  {
    label: 'Your Keys, Your Machine',
    detail: 'API keys never leave your local environment. Zero trust required.',
    accent: 'border-crust-500/40',
  },
  {
    label: 'Multi-Agent Consensus',
    detail: 'Multiple AI models review independently. The platform synthesizes a unified verdict.',
    accent: 'border-crust-400/40',
  },
  {
    label: 'Reputation System',
    detail: 'Agents earn reputation through quality reviews. The best rise to the top.',
    accent: 'border-crust-300/40',
  },
];

const stats = [
  { value: '1,200+', label: 'Reviews Completed' },
  { value: '84', label: 'Active Agents' },
  { value: '3', label: 'AI Models Supported' },
  { value: '99.2%', label: 'Uptime' },
];

function TerminalWindow() {
  return (
    <div className="animate-fade-up animate-delay-3 mx-auto max-w-2xl">
      {/* Terminal chrome */}
      <div className="flex items-center gap-2 rounded-t-lg border border-b-0 border-surface-800/80 bg-surface-900/90 px-4 py-2.5">
        <span className="h-3 w-3 rounded-full bg-diff-red/70" />
        <span className="h-3 w-3 rounded-full bg-crust-400/70" />
        <span className="h-3 w-3 rounded-full bg-diff-green/70" />
        <span className="ml-3 font-mono text-xs tracking-wide text-surface-400">
          opencrust agent start
        </span>
      </div>

      {/* Terminal body */}
      <div className="scanline-overlay relative overflow-hidden rounded-b-lg border border-surface-800/80 bg-surface-950/95 p-5 font-mono text-sm leading-relaxed backdrop-blur-sm">
        <div className="terminal-line terminal-line-1 text-surface-400">
          <span className="text-crust-500">&gt;</span> Connecting to platform...
        </div>
        <div className="terminal-line terminal-line-2 text-diff-green">
          <span className="text-crust-500">&gt;</span> Connected. Waiting for review requests...
        </div>
        <div className="terminal-line terminal-line-3 mt-3 text-crust-400">
          {'['}review{']'} PR #142 &mdash; acme/widgets &mdash; &quot;Add OAuth flow&quot;
        </div>
        <div className="terminal-line terminal-line-4 text-surface-400">
          <span className="text-surface-400/60">
            {'  '}analyzing 12 files, 847 lines changed...
          </span>
        </div>
        <div className="terminal-line terminal-line-5 mt-2 text-surface-100">
          <span className="text-crust-500">Agent-1</span>{' '}
          <span className="text-diff-green">APPROVE</span>{' '}
          <span className="text-surface-400/80">
            &mdash; &quot;Clean implementation. One suggestion on error handling.&quot;
          </span>
        </div>
        <div className="terminal-line terminal-line-6 text-surface-100">
          <span className="text-crust-500">Agent-2</span>{' '}
          <span className="text-diff-green">APPROVE</span>{' '}
          <span className="text-surface-400/80">
            &mdash; &quot;LGTM. Token refresh logic is solid.&quot;
          </span>
        </div>
        <div className="terminal-line terminal-line-7 mt-3 text-diff-green">
          <span className="text-crust-500">&gt;</span> Summary posted to GitHub PR #142{' '}
          <span className="cursor-blink">_</span>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <div className="grid-bg relative overflow-hidden">
      {/* ── Hero glow orb ── */}
      <div
        className="hero-glow pointer-events-none absolute -top-40 left-1/2 h-[600px] w-[800px] -translate-x-1/2"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(234,88,12,0.15) 0%, rgba(234,88,12,0.05) 40%, transparent 70%)',
        }}
      />

      {/* ── Floating particles ── */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="particle" style={{ top: '15%', left: '10%', animationDelay: '0s' }} />
        <div className="particle" style={{ top: '25%', left: '85%', animationDelay: '1s' }} />
        <div className="particle" style={{ top: '60%', left: '20%', animationDelay: '2s' }} />
        <div className="particle" style={{ top: '70%', left: '75%', animationDelay: '3s' }} />
        <div className="particle" style={{ top: '40%', left: '50%', animationDelay: '4s' }} />
        <div className="particle" style={{ top: '80%', left: '35%', animationDelay: '1.5s' }} />
      </div>

      {/* ══════════════════════════════════════════════
          SECTION 1 — Hero
      ══════════════════════════════════════════════ */}
      <section className="relative mx-auto max-w-5xl px-6 pt-28 pb-16 text-center">
        {/* Eyebrow */}
        <div className="animate-fade-up animate-delay-1 mb-6 inline-flex items-center gap-2 rounded-full border border-crust-700/40 bg-crust-900/20 px-4 py-1.5 text-xs font-medium tracking-widest text-crust-400 uppercase">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-crust-500"
            style={{ boxShadow: '0 0 6px rgba(249,115,22,0.6)' }}
          />
          Open Source &middot; Self-Hosted &middot; Multi-Agent
        </div>

        <h1
          className="animate-fade-up animate-delay-2 mx-auto max-w-3xl bg-gradient-to-r from-surface-50 via-surface-50 to-crust-400 bg-clip-text text-5xl leading-[1.1] font-extrabold tracking-tight text-transparent sm:text-6xl lg:text-7xl"
          style={{ WebkitBackgroundClip: 'text' }}
        >
          Distributed AI Code Review
        </h1>

        <p className="animate-fade-up animate-delay-3 mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-surface-100/60 sm:text-xl">
          An open-source platform that coordinates multi-agent code reviews on GitHub PRs.
          Contributors bring their own AI keys&mdash;the platform handles orchestration, consensus,
          and reputation.
        </p>

        <div className="animate-fade-up animate-delay-4 mt-10 flex flex-wrap justify-center gap-4">
          <a
            href="https://github.com/apps/opencrust"
            className="group relative inline-flex items-center gap-2 rounded-lg bg-crust-600 px-7 py-3.5 font-semibold text-white shadow-lg shadow-crust-600/20 transition-all duration-200 hover:bg-crust-500 hover:shadow-crust-500/30"
          >
            Get Started
            <span className="transition-transform duration-200 group-hover:translate-x-0.5">
              &rarr;
            </span>
          </a>
          <a
            href="/community"
            className="inline-flex items-center gap-2 rounded-lg border border-surface-800 bg-surface-900/50 px-7 py-3.5 font-semibold text-surface-100 backdrop-blur-sm transition-all duration-200 hover:border-crust-700 hover:text-crust-400"
          >
            View Community
          </a>
        </div>
      </section>

      {/* ══════════════════════════════════════════════
          SECTION 2 — Terminal Demo
      ══════════════════════════════════════════════ */}
      <section className="relative mx-auto max-w-5xl px-6 pb-24">
        <TerminalWindow />
      </section>

      {/* ══════════════════════════════════════════════
          SECTION 3 — Value Props
      ══════════════════════════════════════════════ */}
      <section className="relative border-t border-surface-800/60 py-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mb-16 text-center">
            <h2 className="animate-fade-up text-3xl font-bold tracking-tight text-surface-50 sm:text-4xl">
              Why OpenCrust
            </h2>
            <p className="animate-fade-up animate-delay-1 mx-auto mt-4 max-w-lg text-surface-100/50">
              A code review system designed for how open-source actually works.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {valueProps.map((prop, i) => (
              <div
                key={prop.label}
                className={`card-glow animate-fade-up rounded-xl border-l-2 ${prop.accent} bg-surface-900/40 p-6 backdrop-blur-sm`}
                style={{ animationDelay: `${0.1 + i * 0.1}s` }}
              >
                <h3 className="mb-2 text-base font-semibold text-surface-50">{prop.label}</h3>
                <p className="text-sm leading-relaxed text-surface-100/50">{prop.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════
          SECTION 4 — How It Works
      ══════════════════════════════════════════════ */}
      <section className="relative border-t border-surface-800/60 py-24">
        <div className="mx-auto max-w-4xl px-6">
          <div className="mb-16 text-center">
            <h2 className="animate-fade-up text-3xl font-bold tracking-tight text-surface-50 sm:text-4xl">
              How It Works
            </h2>
            <p className="animate-fade-up animate-delay-1 mx-auto mt-4 max-w-md text-surface-100/50">
              From install to review in under five minutes.
            </p>
          </div>

          <div className="relative">
            {/* Vertical connector line */}
            <div
              className="absolute top-0 left-8 hidden h-full w-px sm:block"
              style={{
                background:
                  'linear-gradient(to bottom, transparent, rgba(234,88,12,0.3) 10%, rgba(234,88,12,0.3) 90%, transparent)',
              }}
            />

            <div className="space-y-8">
              {steps.map((step, i) => (
                <div
                  key={step.number}
                  className="animate-fade-up relative flex gap-6"
                  style={{ animationDelay: `${0.15 + i * 0.12}s` }}
                >
                  {/* Step number */}
                  <div className="relative z-10 flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-surface-800/80 bg-surface-900/80 text-2xl">
                    {step.icon}
                  </div>

                  {/* Content */}
                  <div className="pt-1">
                    <div className="mb-1 flex items-center gap-3">
                      <span className="font-mono text-xs font-bold tracking-widest text-crust-500">
                        STEP {step.number}
                      </span>
                    </div>
                    <h3 className="mb-1 text-lg font-semibold text-surface-50">{step.title}</h3>
                    <p className="max-w-md text-sm leading-relaxed text-surface-100/50">
                      {step.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════
          SECTION 5 — Stats
      ══════════════════════════════════════════════ */}
      <section className="relative border-t border-surface-800/60 py-20">
        <div className="mx-auto max-w-5xl px-6">
          <div className="grid grid-cols-2 gap-8 lg:grid-cols-4">
            {stats.map((stat, i) => (
              <div
                key={stat.label}
                className="animate-fade-up text-center"
                style={{ animationDelay: `${0.1 + i * 0.08}s` }}
              >
                <div className="stat-shimmer text-4xl font-extrabold tracking-tight sm:text-5xl">
                  {stat.value}
                </div>
                <div className="mt-2 text-sm font-medium tracking-wide text-surface-100/40 uppercase">
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════
          SECTION 6 — Final CTA
      ══════════════════════════════════════════════ */}
      <section className="relative border-t border-surface-800/60 py-28">
        {/* Background glow */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse at 50% 100%, rgba(234,88,12,0.08) 0%, transparent 60%)',
          }}
        />

        <div className="relative mx-auto max-w-3xl px-6 text-center">
          <h2 className="animate-fade-up text-3xl font-bold tracking-tight text-surface-50 sm:text-4xl">
            Ready to level up your code reviews?
          </h2>
          <p className="animate-fade-up animate-delay-1 mx-auto mt-4 max-w-lg text-surface-100/50">
            Install the GitHub App, run the agent, and let AI handle the heavy lifting. Your API
            keys stay on your machine&mdash;always.
          </p>
          <div className="animate-fade-up animate-delay-2 mt-10 flex flex-wrap justify-center gap-4">
            <a
              href="https://github.com/apps/opencrust"
              className="group inline-flex items-center gap-2 rounded-lg bg-crust-600 px-8 py-4 text-lg font-semibold text-white shadow-lg shadow-crust-600/20 transition-all duration-200 hover:bg-crust-500 hover:shadow-crust-500/30"
            >
              Get Started Free
              <span className="transition-transform duration-200 group-hover:translate-x-0.5">
                &rarr;
              </span>
            </a>
            <a
              href="https://github.com/yugoo-ai/OpenCrust"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-surface-800 bg-surface-900/50 px-8 py-4 text-lg font-semibold text-surface-100 backdrop-blur-sm transition-all duration-200 hover:border-crust-700 hover:text-crust-400"
            >
              Star on GitHub
            </a>
          </div>
          <p className="mt-6 text-xs text-surface-100/30">
            Free &amp; open source &middot; MIT License &middot; No credit card required
          </p>
        </div>
      </section>
    </div>
  );
}

const steps = [
  {
    number: '1',
    title: 'Install the GitHub App',
    description: 'Add the OpenCrust GitHub App to your repository in one click.',
  },
  {
    number: '2',
    title: 'Run the Agent Locally',
    description:
      'Contributors run opencrust agent start with their own API keys. Your keys never leave your machine.',
  },
  {
    number: '3',
    title: 'AI Reviews Your PRs',
    description:
      'AI agents review pull requests using your preferred model and tools, right from your local environment.',
  },
  {
    number: '4',
    title: 'Results Posted to GitHub',
    description:
      'The platform aggregates reviews from multiple agents and posts a unified summary on the PR.',
  },
];

export default function Home() {
  return (
    <div>
      <section className="mx-auto max-w-4xl px-4 py-24 text-center">
        <h1 className="text-5xl font-bold tracking-tight text-surface-50">
          Distributed AI Code Review
        </h1>
        <p className="mt-4 text-lg text-surface-100/70">
          Open-source platform that coordinates multi-agent code reviews on GitHub PRs. Contributors
          bring their own AI keys &mdash; the platform handles the rest.
        </p>
        <div className="mt-8 flex justify-center gap-4">
          <a
            href="https://github.com/apps/opencrust"
            className="rounded-md bg-crust-600 px-6 py-3 font-medium text-white hover:bg-crust-500"
          >
            Get Started
          </a>
          <a
            href="/leaderboard"
            className="rounded-md border border-surface-800 px-6 py-3 font-medium text-surface-100 hover:border-crust-600 hover:text-crust-400"
          >
            View Leaderboard
          </a>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-24">
        <h2 className="mb-12 text-center text-3xl font-bold text-surface-50">How It Works</h2>
        <div className="grid gap-8 sm:grid-cols-2">
          {steps.map((step) => (
            <div key={step.number} className="rounded-lg border border-surface-800 p-6">
              <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-crust-600 text-sm font-bold text-white">
                {step.number}
              </div>
              <h3 className="mb-2 text-lg font-semibold text-surface-50">{step.title}</h3>
              <p className="text-surface-100/70">{step.description}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

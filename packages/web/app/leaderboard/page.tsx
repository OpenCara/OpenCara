export const dynamic = 'force-dynamic';

export default function LeaderboardPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="mb-8 text-3xl font-bold text-surface-50">Leaderboard</h1>
      <div className="rounded-lg border border-surface-800 p-12 text-center">
        <p className="text-surface-100/60">
          The leaderboard has been replaced with project stats and trust tiers.
        </p>
        <p className="mt-2 text-sm text-surface-100/40">
          Check the dashboard for your agent trust tiers.
        </p>
      </div>
    </div>
  );
}

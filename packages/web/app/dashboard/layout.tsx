'use client';

import { isAuthenticated, getLoginUrl } from '../../lib/auth';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  if (!isAuthenticated()) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-24 text-center">
        <h1 className="mb-4 text-3xl font-bold text-surface-50">Sign in to view your dashboard</h1>
        <p className="mb-8 text-surface-100/70">
          Log in with GitHub to see your agents, stats, and consumption data.
        </p>
        <a
          href={getLoginUrl()}
          className="rounded-md bg-crust-600 px-6 py-3 font-medium text-white hover:bg-crust-500"
        >
          Login with GitHub
        </a>
      </div>
    );
  }

  return <>{children}</>;
}

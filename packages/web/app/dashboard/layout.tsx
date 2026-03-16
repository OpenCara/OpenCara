'use client';

import { useEffect, useState } from 'react';
import { isAuthenticated, getLoginUrl } from '../../lib/auth';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-24 text-center">
        <div className="animate-pulse">
          <div className="mx-auto mb-4 h-8 w-64 rounded bg-surface-800" />
          <div className="mx-auto mb-8 h-4 w-96 rounded bg-surface-800" />
          <div className="mx-auto h-12 w-48 rounded bg-surface-800" />
        </div>
      </div>
    );
  }

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

'use client';

import { useEffect, useState } from 'react';
import { isAuthenticated, getLoginUrl, getLogoutUrl } from '../../lib/auth';

export default function NavBar() {
  const [authed, setAuthed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setAuthed(isAuthenticated());
    setMounted(true);
  }, []);

  return (
    <header className="border-b border-surface-800">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <a href="/" className="text-xl font-bold text-crust-500">
          OpenCrust
        </a>
        <div className="flex items-center gap-6">
          <a href="/leaderboard" className="text-surface-100 hover:text-crust-400">
            Leaderboard
          </a>
          {mounted && authed && (
            <a href="/dashboard" className="text-surface-100 hover:text-crust-400">
              Dashboard
            </a>
          )}
          {mounted &&
            (authed ? (
              <a
                href={getLogoutUrl()}
                className="rounded-md border border-surface-800 px-4 py-2 text-sm font-medium text-surface-100 hover:border-crust-600 hover:text-crust-400"
              >
                Logout
              </a>
            ) : (
              <a
                href={getLoginUrl()}
                className="rounded-md bg-crust-600 px-4 py-2 text-sm font-medium text-white hover:bg-crust-500"
              >
                Login
              </a>
            ))}
        </div>
      </nav>
    </header>
  );
}

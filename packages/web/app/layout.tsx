import './globals.css';

export const metadata = {
  title: 'OpenCrust',
  description: 'Distributed AI code review',
};

function NavBar() {
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
          <a href="/dashboard" className="text-surface-100 hover:text-crust-400">
            Dashboard
          </a>
          <button className="rounded-md bg-crust-600 px-4 py-2 text-sm font-medium text-white hover:bg-crust-500">
            Login
          </button>
        </div>
      </nav>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-surface-800 py-8">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 text-sm text-surface-100/60">
        <span>&copy; {new Date().getFullYear()} OpenCrust</span>
        <div className="flex gap-4">
          <a
            href="https://github.com/yugoo-ai/OpenCrust"
            className="hover:text-crust-400"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          <a href="/docs" className="hover:text-crust-400">
            Docs
          </a>
        </div>
      </div>
    </footer>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="flex min-h-screen flex-col">
        <NavBar />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}

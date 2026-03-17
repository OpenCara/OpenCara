import './globals.css';
import NavBar from './components/NavBar';

export const metadata = {
  title: 'OpenCrust',
  description: 'Distributed AI code review',
};

function Footer() {
  return (
    <footer className="border-t border-surface-800 py-8">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 text-sm text-surface-100/60">
        <span>&copy; {new Date().getFullYear()} OpenCrust</span>
        <div className="flex gap-4">
          <a
            href="https://discord.gg/JGnmrUXF"
            className="hover:text-crust-400"
            target="_blank"
            rel="noopener noreferrer"
          >
            Discord
          </a>
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

export default function NavBar() {
  return (
    <header className="border-b border-surface-800">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <a href="/" className="text-xl font-bold text-crust-500">
          OpenCrust
        </a>
        <div className="flex items-center gap-6">
          <a href="/community" className="text-surface-100 hover:text-crust-400">
            Community
          </a>
          <a
            href="https://discord.gg/JGnmrUXF"
            target="_blank"
            rel="noopener noreferrer"
            className="text-surface-100 hover:text-crust-400"
          >
            Discord
          </a>
          <a
            href="https://github.com/yugoo-ai/OpenCrust"
            target="_blank"
            rel="noopener noreferrer"
            className="text-surface-100 hover:text-crust-400"
          >
            GitHub
          </a>
        </div>
      </nav>
    </header>
  );
}

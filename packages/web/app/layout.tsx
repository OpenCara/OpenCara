export const metadata = {
  title: 'OpenCrust',
  description: 'Distributed AI code review',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

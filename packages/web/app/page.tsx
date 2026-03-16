import { getVersion } from '@opencrust/shared';

export default function Home() {
  return (
    <main>
      <h1>OpenCrust</h1>
      <p>Distributed AI code review</p>
      <p>v{getVersion()}</p>
    </main>
  );
}

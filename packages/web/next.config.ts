import type { NextConfig } from 'next';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const nextConfig: NextConfig = {
  outputFileTracingRoot: resolve(__dirname, '../../'),
};

export default nextConfig;

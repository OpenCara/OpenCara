/**
 * Shared build-time helper: reads tools/*.toml and returns ToolDef[].
 * Used by both tsup.config.ts and vitest.config.ts to produce __TOOL_DEFS__.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';

export interface ToolDefRaw {
  name: string;
  binary: string;
  models: string[];
  command: string;
  scannable: boolean;
  installLink?: string;
}

export function loadToolDefsFromDir(toolsDir: string): ToolDefRaw[] {
  return readdirSync(toolsDir)
    .filter((f) => f.endsWith('.toml'))
    .sort()
    .map((f) => {
      const raw = readFileSync(resolve(toolsDir, f), 'utf-8');
      const data = parseToml(raw) as Record<string, unknown>;
      const name = basename(f, '.toml');

      if (typeof data.binary !== 'string') throw new Error(`tools/${f}: missing "binary" field`);
      if (!Array.isArray(data.models)) throw new Error(`tools/${f}: missing "models" array`);
      if (typeof data.command !== 'string') throw new Error(`tools/${f}: missing "command" field`);
      if (typeof data.scannable !== 'boolean')
        throw new Error(`tools/${f}: missing "scannable" field`);

      return {
        name,
        binary: data.binary,
        models: data.models as string[],
        command: data.command,
        scannable: data.scannable,
        installLink: typeof data.install_link === 'string' ? data.install_link : undefined,
      };
    });
}

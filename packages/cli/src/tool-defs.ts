/** Build-time injected JSON string of tool definitions from tools/*.toml */
declare const __TOOL_DEFS__: string;

export interface ToolDef {
  name: string;
  binary: string;
  models: string[];
  command: string;
  scannable: boolean;
  installLink?: string;
}

let _cache: ToolDef[] | null = null;

/** Load all tool definitions (parsed from TOML at build time, cached). */
export function loadToolDefs(): ToolDef[] {
  if (!_cache) {
    _cache = JSON.parse(__TOOL_DEFS__) as ToolDef[];
  }
  return _cache;
}

/** Look up a tool definition by name. */
export function getToolDef(name: string): ToolDef | undefined {
  return loadToolDefs().find((t) => t.name === name);
}

/** Return tools that should be auto-detected during setup (scannable === true). */
export function getScannableTools(): ToolDef[] {
  return loadToolDefs().filter((t) => t.scannable);
}

/** Return the set of all known tool names. */
export function getKnownToolNames(): Set<string> {
  return new Set(loadToolDefs().map((t) => t.name));
}

/**
 * Dependency extraction for review maps. Edges are inferred from each
 * language's import/reference syntax and only ever connect files that are in
 * the PR — a changed file importing an unchanged one is invisible noise on a
 * review map, so non-changed targets are dropped.
 *
 * Resolvers are a registry (Open/Closed): adding a language means appending
 * one entry, not touching the dispatcher. Each `extract` sees the file's own
 * content plus the full changed-path set (and the contents of every fetched
 * file, for type-name scans like C#).
 */

export interface DependencyFile {
  path: string;
  /** Undefined when content wasn't fetched (removed, oversized, fetch failed). */
  content?: string;
}

export interface DependencyEdge {
  source: string;
  target: string;
}

interface ResolverCtx {
  /** Path of the file being parsed. */
  path: string;
  /** Directory of the file being parsed ("" at repo root). */
  dir: string;
  content: string;
  /** All changed paths on the PR, for membership tests. */
  changedPaths: Set<string>;
  /** Changed paths that have content available. */
  files: DependencyFile[];
}

interface Resolver {
  id: string;
  extensions: string[];
  extract(ctx: ResolverCtx): DependencyEdge[];
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function baseOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Resolve a relative specifier ("./a", "../b") against a file's dir. */
function resolveRelative(dir: string, spec: string): string {
  const parts = (dir ? dir.split("/") : []).concat(spec.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/** Match any changed path equal to `candidate` or ending in `/${candidate}`. */
function suffixMatch(candidate: string, changedPaths: Set<string>): string[] {
  const out: string[] = [];
  const tail = `/${candidate}`;
  for (const p of changedPaths) {
    if (p === candidate || p.endsWith(tail)) out.push(p);
  }
  return out;
}

function edgesTo(
  source: string,
  candidates: string[],
  changedPaths: Set<string>,
  matchSuffix: boolean,
): DependencyEdge[] {
  const out: DependencyEdge[] = [];
  for (const c of candidates) {
    const hits = matchSuffix
      ? suffixMatch(c, changedPaths)
      : changedPaths.has(c)
        ? [c]
        : [];
    for (const t of hits) {
      if (t !== source) out.push({ source, target: t });
    }
  }
  return out;
}

// ── TypeScript / JavaScript ──────────────────────────────────────────────

const TS_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
];
// ESM files commonly import with the *emitted* extension (.js) while the
// changed file on disk is TypeScript (.ts) — map each pair.
const JS_TO_TS: Record<string, string> = {
  ".js": ".ts",
  ".jsx": ".tsx",
  ".mjs": ".mts",
  ".cjs": ".cts",
};

const TS_SPECIFIER_RE =
  /(?:\bimport\b[^'";]*?\bfrom|\bexport\b[^'";]*?\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g;

const tsResolver: Resolver = {
  id: "ts",
  extensions: TS_EXTENSIONS,
  extract({ path, dir, content, changedPaths }) {
    const edges: DependencyEdge[] = [];
    for (const m of content.matchAll(TS_SPECIFIER_RE)) {
      const spec = m[1]!;
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      const resolved = resolveRelative(dir, spec);
      const candidates = [resolved];
      const ext = spec.match(/\.(jsx?|mjs|cjs|tsx?|mts|cts|vue|svelte)$/)?.[0];
      if (ext && JS_TO_TS[ext]) {
        candidates.push(resolved.slice(0, -ext.length) + JS_TO_TS[ext]);
      }
      if (!ext) {
        for (const e of TS_EXTENSIONS) {
          candidates.push(resolved + e);
          candidates.push(`${resolved}/index${e}`);
        }
      }
      edges.push(...edgesTo(path, candidates, changedPaths, false));
    }
    return edges;
  },
};

// ── Python ───────────────────────────────────────────────────────────────

const PY_FROM_RE = /^\s*from\s+([.\w]+)\s+import\s+/gm;
const PY_IMPORT_RE = /^\s*import\s+([\w.]+)/gm;

const pythonResolver: Resolver = {
  id: "python",
  extensions: [".py"],
  extract({ path, dir, content, changedPaths }) {
    const edges: DependencyEdge[] = [];
    const pushModule = (modulePath: string, fromDir: string) => {
      const rel = modulePath.replace(/\./g, "/");
      const base = fromDir ? `${fromDir}/` : "";
      edges.push(
        ...edgesTo(
          path,
          [`${base}${rel}.py`, `${base}${rel}/__init__.py`],
          changedPaths,
          true,
        ),
      );
    };
    for (const m of content.matchAll(PY_FROM_RE)) {
      const mod = m[1]!;
      const dots = mod.match(/^\.+/)?.[0].length ?? 0;
      const rest = mod.slice(dots);
      if (dots > 0) {
        // `from ..x import y` climbs (dots - 1) directories above `dir`.
        let base = dir;
        for (let i = 1; i < dots && base !== ""; i++) base = dirOf(base);
        if (rest) pushModule(rest, base);
        else edges.push(...edgesTo(path, [`${base}/__init__.py`], changedPaths, true));
      } else {
        pushModule(rest, "");
      }
    }
    for (const m of content.matchAll(PY_IMPORT_RE)) {
      pushModule(m[1]!, "");
    }
    return edges;
  },
};

// ── Go ───────────────────────────────────────────────────────────────────

const GO_SINGLE_IMPORT_RE = /\bimport\s+"([^"]+)"/g;
const GO_BLOCK_RE = /\bimport\s*\(([^)]*)\)/g;
const GO_QUOTED_RE = /"([^"]+)"/g;

const goResolver: Resolver = {
  id: "go",
  extensions: [".go"],
  extract({ path, dir, content, changedPaths }) {
    const imports: string[] = [];
    for (const m of content.matchAll(GO_SINGLE_IMPORT_RE)) imports.push(m[1]!);
    for (const m of content.matchAll(GO_BLOCK_RE)) {
      for (const q of m[1]!.matchAll(GO_QUOTED_RE)) imports.push(q[1]!);
    }
    // An import path names a package directory: edge to changed .go files
    // whose dir equals the path or sits at a path-suffix of it. Same-package
    // (same dir) edges are skipped — siblings are trivially related and
    // would drown the cross-package signal.
    const edges: DependencyEdge[] = [];
    for (const imp of imports) {
      for (const f of changedPaths) {
        if (f === path || !f.endsWith(".go")) continue;
        const fd = dirOf(f);
        if (!fd || fd === dir) continue;
        if (fd === imp || imp === fd || imp.endsWith(`/${fd}`)) {
          edges.push({ source: path, target: f });
        }
      }
    }
    return edges;
  },
};

// ── Rust ─────────────────────────────────────────────────────────────────

const RUST_MOD_RE = /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm;
const RUST_USE_RE = /\buse\s+crate::([\w:]+)/g;

const rustResolver: Resolver = {
  id: "rust",
  extensions: [".rs"],
  extract({ path, dir, content, changedPaths }) {
    const edges: DependencyEdge[] = [];
    const base = baseOf(path);
    // `mod x;` lives one dir down for mod.rs/lib.rs/main.rs; other files get
    // a directory named after their stem (foo.rs → foo/x.rs).
    const modBase =
      base === "mod.rs" || base === "lib.rs" || base === "main.rs"
        ? dir
        : `${dir ? `${dir}/` : ""}${base.slice(0, -".rs".length)}`;
    for (const m of content.matchAll(RUST_MOD_RE)) {
      const name = m[1]!;
      edges.push(
        ...edgesTo(
          path,
          [`${modBase}/${name}.rs`, `${modBase}/${name}/mod.rs`],
          changedPaths,
          false,
        ),
      );
    }
    for (const m of content.matchAll(RUST_USE_RE)) {
      const segments = m[1]!.split("::").filter((s) => /^\w+$/.test(s));
      const candidates: string[] = [];
      for (let k = segments.length; k >= 1; k--) {
        const p = segments.slice(0, k).join("/");
        candidates.push(`${p}.rs`, `${p}/mod.rs`, `src/${p}.rs`, `src/${p}/mod.rs`);
      }
      edges.push(...edgesTo(path, candidates, changedPaths, true));
    }
    return edges;
  },
};

// ── C / C++ ──────────────────────────────────────────────────────────────

const C_INCLUDE_RE = /^\s*#\s*include\s+"([^"]+)"/gm;

const cResolver: Resolver = {
  id: "c",
  extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"],
  extract({ path, dir, content, changedPaths }) {
    const edges: DependencyEdge[] = [];
    for (const m of content.matchAll(C_INCLUDE_RE)) {
      const inc = m[1]!.replace(/^\.\//, "");
      const local = resolveRelative(dir, inc);
      // Quoted includes are relative to the including file; fall back to a
      // path-suffix match for include-path style quotes.
      const before = edges.length;
      edges.push(...edgesTo(path, [local], changedPaths, false));
      if (edges.length === before) {
        edges.push(...edgesTo(path, [inc], changedPaths, true));
      }
    }
    return edges;
  },
};

// ── Java / Kotlin ────────────────────────────────────────────────────────

const JVM_IMPORT_RE = /^\s*import\s+([\w.]+)/gm;

const jvmResolver: Resolver = {
  id: "jvm",
  extensions: [".java", ".kt", ".kts"],
  extract({ path, content, changedPaths }) {
    const edges: DependencyEdge[] = [];
    for (const m of content.matchAll(JVM_IMPORT_RE)) {
      const p = m[1]!.replace(/\./g, "/");
      edges.push(
        ...edgesTo(
          path,
          [`${p}.java`, `${p}.kt`, `${p}.kts`],
          changedPaths,
          true,
        ),
      );
    }
    return edges;
  },
};

// ── C# ───────────────────────────────────────────────────────────────────

const CSHARP_TYPE_DECL_RE =
  /\b(?:class|struct|interface|enum|record)\s+([A-Za-z_]\w{2,})/g;
const LINE_COMMENT_RE = /\/\/[^\n]*/g;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const STRING_RE = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;

/**
 * C# has no import-statement equivalent per file (using directives name
 * namespaces, not files), so edges come from referencing a type that another
 * changed file declares. A two-pass heuristic: collect declarations from all
 * changed .cs files, then grep each file's comment/string-stripped content.
 */
const csharpResolver: Resolver = {
  id: "csharp",
  extensions: [".cs"],
  extract({ path, content, files }) {
    const declared = new Map<string, string>(); // type name -> declaring path
    for (const f of files) {
      if (f.path === path || !f.path.endsWith(".cs") || f.content === undefined)
        continue;
      for (const m of f.content.matchAll(CSHARP_TYPE_DECL_RE)) {
        declared.set(m[1]!, f.path);
      }
    }
    if (declared.size === 0) return [];
    const stripped = content
      .replace(BLOCK_COMMENT_RE, "")
      .replace(LINE_COMMENT_RE, "")
      .replace(STRING_RE, '""');
    const edges: DependencyEdge[] = [];
    for (const [name, target] of declared) {
      if (new RegExp(`\\b${name}\\b`).test(stripped)) {
        edges.push({ source: path, target });
      }
    }
    return edges;
  },
};

// ── GDScript ─────────────────────────────────────────────────────────────

const GD_RES_RE = /\b(?:preload|load)\s*\(\s*["']res:\/\/([^"']+)["']\s*\)|\bextends\s+["']res:\/\/([^"']+)["']/g;
const GD_CLASS_NAME_RE = /^\s*class_name\s+(\w+)/gm;

const gdscriptResolver: Resolver = {
  id: "gdscript",
  extensions: [".gd"],
  extract({ path, content, files, changedPaths }) {
    const edges: DependencyEdge[] = [];
    for (const m of content.matchAll(GD_RES_RE)) {
      const res = m[1] ?? m[2]!;
      edges.push(...edgesTo(path, [res], changedPaths, true));
    }
    // class_name registers a global identifier: an edge exists when another
    // changed .gd file declares a name this file references.
    const declared = new Map<string, string>();
    for (const f of files) {
      if (f.path === path || !f.path.endsWith(".gd") || f.content === undefined)
        continue;
      for (const m of f.content.matchAll(GD_CLASS_NAME_RE)) {
        declared.set(m[1]!, f.path);
      }
    }
    const stripped = content
      .replace(LINE_COMMENT_RE_GD, "")
      .replace(STRING_RE, '""');
    for (const [name, target] of declared) {
      if (new RegExp(`\\b${name}\\b`).test(stripped)) {
        edges.push({ source: path, target });
      }
    }
    return edges;
  },
};

const LINE_COMMENT_RE_GD = /#[^\n]*/g;

// ── Registry ─────────────────────────────────────────────────────────────

const resolvers: Resolver[] = [
  tsResolver,
  pythonResolver,
  goResolver,
  rustResolver,
  cResolver,
  jvmResolver,
  csharpResolver,
  gdscriptResolver,
];

function resolverFor(path: string): Resolver | undefined {
  const lower = path.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf("."));
  return resolvers.find((r) => r.extensions.includes(ext));
}

/** True when any resolver knows how to parse this path. */
export function isParsable(path: string): boolean {
  return resolverFor(path) !== undefined;
}

/** Id of the resolver that would parse this path, for `ReviewMapFile.language`. */
export function languageForPath(path: string): string | undefined {
  return resolverFor(path)?.id;
}

/**
 * Compute dependency edges between changed files. `files` carries whatever
 * contents were fetched; `changedPaths` bounds the target set. Output is
 * deduplicated and free of self-edges.
 */
export function resolveDependencies(
  files: DependencyFile[],
  changedPaths: string[],
): DependencyEdge[] {
  const changed = new Set(changedPaths);
  const seen = new Set<string>();
  const edges: DependencyEdge[] = [];
  for (const f of files) {
    const resolver = resolverFor(f.path);
    if (!resolver || f.content === undefined) continue;
    for (const e of resolver.extract({
      path: f.path,
      dir: dirOf(f.path),
      content: f.content,
      changedPaths: changed,
      files,
    })) {
      if (e.source === e.target) continue;
      const key = `${e.source}→${e.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(e);
    }
  }
  return edges;
}

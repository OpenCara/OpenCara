import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isParsable,
  languageForPath,
  resolveDependencies,
} from "../dependencies.js";

function dep(files: { path: string; content: string }[], extraChanged: string[] = []) {
  const changed = [...files.map((f) => f.path), ...extraChanged];
  return resolveDependencies(files, changed);
}

describe("resolveDependencies — ts/js", () => {
  it("edges a relative import to its changed target", () => {
    const edges = dep([
      { path: "src/app.ts", content: `import { helper } from "./util";` },
      { path: "src/util.ts", content: `export const helper = 1;` },
    ]);
    assert.deepEqual(edges, [{ source: "src/app.ts", target: "src/util.ts" }]);
  });

  it("maps an emitted .js specifier back to the .ts source", () => {
    const edges = dep([
      { path: "src/app.ts", content: `import "./polyfill.js";` },
      { path: "src/polyfill.ts", content: `` },
    ]);
    assert.deepEqual(edges, [
      { source: "src/app.ts", target: "src/polyfill.ts" },
    ]);
  });

  it("resolves index and parent-relative imports", () => {
    const edges = dep([
      {
        path: "src/ui/app.ts",
        content: `export * from "../lib";`,
      },
      { path: "src/lib/index.ts", content: "" },
    ]);
    assert.deepEqual(edges, [
      { source: "src/ui/app.ts", target: "src/lib/index.ts" },
    ]);
  });

  it("ignores package imports and files outside the change set", () => {
    const edges = dep([
      {
        path: "src/app.ts",
        content: `import fs from "node:fs"; import x from "react"; import "./gone";`,
      },
      { path: "src/util.ts", content: "" },
    ]);
    assert.deepEqual(edges, []);
  });

  it("handles require and dynamic import", () => {
    const edges = dep([
      {
        path: "a.js",
        content: `const a = require("./b"); const c = import("./c");`,
      },
      { path: "b.ts", content: "" },
      { path: "c.js", content: "" },
    ]);
    assert.deepEqual(edges.sort(), [
      { source: "a.js", target: "b.ts" },
      { source: "a.js", target: "c.js" },
    ]);
  });
});

describe("resolveDependencies — python", () => {
  it("edges an absolute import to a package-suffix match", () => {
    const edges = dep([
      { path: "pkg/service.py", content: `import core.db\nfrom core.util import x` },
      { path: "pkg/core/db.py", content: "" },
      { path: "other/core/util.py", content: "" },
    ]);
    assert.deepEqual(edges.sort((a, b) => a.target.localeCompare(b.target)), [
      { source: "pkg/service.py", target: "other/core/util.py" },
      { source: "pkg/service.py", target: "pkg/core/db.py" },
    ]);
  });

  it("edges a relative import via dot levels", () => {
    const edges = dep([
      { path: "pkg/sub/mod.py", content: `from ..core import thing` },
      { path: "pkg/core.py", content: "" },
    ]);
    assert.deepEqual(edges, [{ source: "pkg/sub/mod.py", target: "pkg/core.py" }]);
  });

  it("does not match non-changed modules", () => {
    const edges = dep([
      { path: "pkg/a.py", content: `import os\nimport unchanged.thing` },
    ]);
    assert.deepEqual(edges, []);
  });
});

describe("resolveDependencies — go", () => {
  it("edges an import path to changed files in that package dir", () => {
    const edges = dep([
      {
        path: "cmd/server/main.go",
        content: `import (\n\t"fmt"\n\t"example.com/app/internal/store"\n)`,
      },
      { path: "internal/store/store.go", content: "" },
      { path: "internal/store/repo.go", content: "" },
    ]);
    assert.deepEqual(edges.sort((a, b) => a.target.localeCompare(b.target)), [
      { source: "cmd/server/main.go", target: "internal/store/repo.go" },
      { source: "cmd/server/main.go", target: "internal/store/store.go" },
    ]);
  });

  it("skips same-package siblings", () => {
    const edges = dep([
      {
        path: "internal/store/a.go",
        content: `import "example.com/app/internal/store"`,
      },
      { path: "internal/store/b.go", content: "" },
    ]);
    assert.deepEqual(edges, []);
  });
});

describe("resolveDependencies — rust", () => {
  it("edges mod declarations from lib.rs", () => {
    const edges = dep([
      { path: "src/lib.rs", content: `pub mod auth;\nmod util;` },
      { path: "src/auth.rs", content: "" },
      { path: "src/util/mod.rs", content: "" },
    ]);
    assert.deepEqual(edges.sort((a, b) => a.target.localeCompare(b.target)), [
      { source: "src/lib.rs", target: "src/auth.rs" },
      { source: "src/lib.rs", target: "src/util/mod.rs" },
    ]);
  });

  it("edges use crate:: paths by suffix", () => {
    const edges = dep([
      { path: "src/bin/tool.rs", content: `use crate::auth::session;` },
      { path: "src/auth.rs", content: "" },
    ]);
    assert.deepEqual(edges, [
      { source: "src/bin/tool.rs", target: "src/auth.rs" },
    ]);
  });

  it("ignores use of external crates", () => {
    const edges = dep([
      { path: "src/a.rs", content: `use serde::Serialize;` },
      { path: "src/b.rs", content: "" },
    ]);
    assert.deepEqual(edges, []);
  });
});

describe("resolveDependencies — c/cpp", () => {
  it("edges a quoted include relative to the file", () => {
    const edges = dep([
      { path: "src/main.c", content: `#include "util/helper.h"` },
      { path: "src/util/helper.h", content: "" },
    ]);
    assert.deepEqual(edges, [
      { source: "src/main.c", target: "src/util/helper.h" },
    ]);
  });

  it("falls back to a suffix match and ignores system includes", () => {
    const edges = dep([
      {
        path: "src/main.c",
        content: `#include <stdio.h>\n#include "config.h"`,
      },
      { path: "include/config.h", content: "" },
    ]);
    assert.deepEqual(edges, [
      { source: "src/main.c", target: "include/config.h" },
    ]);
  });
});

describe("resolveDependencies — java/kotlin", () => {
  it("edges an import to the declared type file by suffix", () => {
    const edges = dep([
      {
        path: "app/src/main/Main.java",
        content: `import com.acme.db.Store;`,
      },
      { path: "lib/src/com/acme/db/Store.java", content: "" },
    ]);
    assert.deepEqual(edges, [
      { source: "app/src/main/Main.java", target: "lib/src/com/acme/db/Store.java" },
    ]);
  });

  it("does not match types outside the change set", () => {
    const edges = dep([
      { path: "Main.kt", content: `import java.util.List` },
      { path: "Other.kt", content: "" },
    ]);
    assert.deepEqual(edges, []);
  });
});

describe("resolveDependencies — csharp", () => {
  it("edges a file referencing a type another changed file declares", () => {
    const edges = dep([
      {
        path: "src/Program.cs",
        content: `var s = new WidgetStore(); s.Load(); // done`,
      },
      {
        path: "src/WidgetStore.cs",
        content: `public class WidgetStore { public void Load() {} }`,
      },
    ]);
    assert.deepEqual(edges, [
      { source: "src/Program.cs", target: "src/WidgetStore.cs" },
    ]);
  });

  it("ignores comments, strings, and short names", () => {
    const edges = dep([
      {
        path: "src/Program.cs",
        content: `// mentions WidgetStore\nvar s = "WidgetStore"; var io = 1;`,
      },
      {
        path: "src/WidgetStore.cs",
        content: `public class WidgetStore {}`,
      },
      { path: "src/Io.cs", content: `public class Io {}` },
    ]);
    assert.deepEqual(edges, []);
  });
});

describe("resolveDependencies — gdscript", () => {
  it("edges preload/load/extends res:// references", () => {
    const edges = dep([
      {
        path: "scenes/main.gd",
        content: `const Bullet = preload("res://scripts/bullet.gd")\nextends "res://scripts/base.gd"`,
      },
      { path: "scripts/bullet.gd", content: "" },
      { path: "scripts/base.gd", content: "" },
    ]);
    assert.deepEqual(edges.sort((a, b) => a.target.localeCompare(b.target)), [
      { source: "scenes/main.gd", target: "scripts/base.gd" },
      { source: "scenes/main.gd", target: "scripts/bullet.gd" },
    ]);
  });

  it("edges class_name references", () => {
    const edges = dep([
      { path: "a.gd", content: `var p: PlayerStats` },
      { path: "b.gd", content: `class_name PlayerStats` },
    ]);
    assert.deepEqual(edges, [{ source: "a.gd", target: "b.gd" }]);
  });
});

describe("resolveDependencies — general", () => {
  it("reports parsability and language ids", () => {
    assert.equal(isParsable("src/a.ts"), true);
    assert.equal(isParsable("src/a.py"), true);
    assert.equal(isParsable("README.md"), false);
    assert.equal(languageForPath("x.go"), "go");
    assert.equal(languageForPath("x.txt"), undefined);
  });

  it("dedupes edges and never self-edges", () => {
    const edges = dep([
      {
        path: "a.ts",
        content: `import "./b"; export * from "./b"; import "./a";`,
      },
      { path: "b.ts", content: "" },
    ]);
    assert.deepEqual(edges, [{ source: "a.ts", target: "b.ts" }]);
  });

  it("skips files with no fetched content", () => {
    const edges = resolveDependencies(
      [{ path: "a.ts" }],
      ["a.ts", "b.ts"],
    );
    assert.deepEqual(edges, []);
  });
});

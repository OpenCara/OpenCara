# Batch Replace

Perform a batch find-and-replace across the codebase using `grep` + `sed`. This is the preferred method for renaming variables, functions, types, or any repeated pattern across multiple files.

## Arguments

The user provides a description of what to replace. Examples:

- `rename WebSocketMessage to ProtocolMessage`
- `replace all fetch( with safeFetch(`
- `rename AgentStatus to ConnectionStatus`

## Instructions

### Step 1: Parse the replacement

Extract the **old pattern** and **new replacement** from the user's description. If ambiguous, ask for clarification.

### Step 2: Find all occurrences

Use `grep` (via the Grep tool) to find all files and lines matching the old pattern:

```
Grep pattern: <old_pattern>
output_mode: content
```

Display the matches to the user so they can verify scope.

### Step 3: Preview the replacement

Show a summary:

- Number of files affected
- Number of occurrences
- The exact `sed` command that will be used

### Step 4: Execute the replacement

Use `sed -i` for the batch replacement. Choose the right approach based on complexity:

**Simple literal string replacement:**

```bash
grep -rl '<old_pattern>' --include='*.ts' --include='*.tsx' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next . | xargs sed -i 's/<old_pattern>/<new_pattern>/g'
```

**Regex replacement:**

```bash
grep -rl '<old_regex>' --include='*.ts' --include='*.tsx' --exclude-dir=node_modules --exclude-dir=dist . | xargs sed -i 's/<old_regex>/<new_replacement>/g'
```

**Important rules:**

- Always scope file types with `--include` (e.g., `--include='*.ts'`, `--include='*.json'`) to avoid modifying binary files, build artifacts, or unrelated files
- Exclude build directories: add `--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next --exclude-dir=.wrangler`
- Use `grep -rl` (files-with-matches + recursive) to find target files first, then pipe to `sed`
- For patterns containing `/`, use a different sed delimiter: `sed -i 's|old|new|g'`
- For patterns with special regex characters, escape them: `\.`, `\[`, `\(`, etc.

### Step 5: Verify

After replacement, run a verification:

1. **Grep again** for the old pattern — should return zero matches
2. **Grep for the new pattern** — should match the expected count
3. **Build check**: `pnpm build`

Report results to the user.

## Guidelines

- **NEVER** edit occurrences one-by-one with the Edit tool — always use batch tools
- **NEVER** use `sed` on binary files or without `--include` file type filters
- Prefer `sed -i` for in-place replacement; use `awk` only when sed can't handle the pattern (e.g., multi-line replacements)
- Always verify with a build after replacement to catch any issues
- If the replacement affects >50 files, ask the user to confirm before executing

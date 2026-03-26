# D1 Migrations

Cloudflare D1 applies migrations in lexicographic order by filename.

## Numbering Convention

- Prefix files with a zero-padded four-digit sequence: `0001_`, `0002_`, etc.
- Each prefix **must be unique** — never reuse a number.
- Never modify an already-applied migration. Create a new numbered file instead.
- Use `IF NOT EXISTS` / `IF EXISTS` guards when possible to make migrations idempotent.

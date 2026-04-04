# OpenCara Features

Comprehensive documentation for every OpenCara feature.

## Feature Guides

| Feature                                              | Description                                                        | Doc          |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ------------ |
| [Code Review & Summarization](review.md)             | Distributed multi-agent PR review with adversarial verification    | Core feature |
| [Issue Triage](triage.md)                            | Automatic issue categorization, prioritization, and labeling       | Optional     |
| [Duplicate Detection](dedup.md)                      | AI-powered duplicate PR/issue detection with 3-comment index       | Optional     |
| [Implement & Fix](implement-fix.md)                  | AI code generation from issues and review comment fixes            | Optional     |
| [Configuration (`.opencara.toml`)](configuration.md) | Full config schema, triggers, access control, defaults             | Reference    |
| [Prompt Security](prompt-security.md)                | Trust boundaries, anti-injection, prompt guard, token sanitization | Security     |

## Quick Links

- [Agent Setup Guide](../agent-guide.md) — Install and configure agents
- [Deployment Guide](../deployment.md) — Deploy server to Cloudflare Workers or VPS
- [Self-Hosting Guide](../self-hosting.md) — Docker and Node.js deployment
- [Security Model](../security.md) — Trust model and attack mitigations
- [Architecture](../architecture.md) — Technical architecture and REST API

## Feature Matrix

| Feature        | Trigger                                   | Scope         | Config Section   |
| -------------- | ----------------------------------------- | ------------- | ---------------- |
| Review         | PR opened / `/opencara review`            | Pull Requests | `[review]`       |
| Triage         | Issue opened / `/opencara triage` / label | Issues        | `[triage]`       |
| Dedup (PRs)    | PR opened                                 | Pull Requests | `[dedup.prs]`    |
| Dedup (Issues) | Issue opened                              | Issues        | `[dedup.issues]` |
| Implement      | `/opencara go [model]` / label            | Issues → PR   | `[implement]`    |
| Fix            | `/opencara fix [model]`                   | Pull Requests | `[fix]`          |

## Task Roles

| Role           | Feature   | Description                      |
| -------------- | --------- | -------------------------------- |
| `review`       | Review    | Individual PR reviewer slot      |
| `summary`      | Review    | Synthesizer/adversarial verifier |
| `pr_triage`    | Triage    | PR triage (uncommon)             |
| `issue_triage` | Triage    | Issue categorization             |
| `pr_dedup`     | Dedup     | PR duplicate detection           |
| `issue_dedup`  | Dedup     | Issue duplicate detection        |
| `implement`    | Implement | Issue → branch → PR              |
| `fix`          | Fix       | Review comments → push fixes     |

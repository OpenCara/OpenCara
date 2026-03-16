# Lessons Learned

## Workflow

- [hits: 1] **QA after every code merge** — PM must spawn QA agent on main after every code PR merge. Multiple milestones (M1, M2, M3) were merged without QA verification. The PM agent definition requires it but PM didn't follow through. Team lead must enforce this.
- [hits: 1] **PM misses messages** — PM sometimes misses team lead responses and re-requests actions already completed (e.g., asking to spawn agents that are already running). May need to re-send confirmations.
- [hits: 1] **Dev agents must test before merge** — Dev agents were merging PRs without running tests against latest main. Added mandatory pre-merge verification step (build + test + lint after merging origin/main).

#!/usr/bin/env node
// Canned-stub implementer used by the v1 built-in `issue-implement` flow.
// Reads the issue + status context JSON on stdin (and OPENCARA_PROMPT env if
// a prompt is linked) and emits a markdown plan on stdout to verify the
// wiring is end-to-end. Swap for `claude --print "..."` or any other agent
// command via the flow node config to make it a real implementer.

import { stdin } from "node:process";

let buf = "";
for await (const chunk of stdin) buf += chunk;

let ctx = {};
try {
  ctx = buf ? JSON.parse(buf) : {};
} catch {
  // ignore parse errors — we just emit a generic plan
}

const repo = process.env.OPENCARA_REPO ?? "?";
const num = process.env.OPENCARA_ISSUE_NUMBER ?? ctx?.issue?.number ?? "?";
const title = ctx?.issue?.title ?? "(no title in context)";
const from = process.env.OPENCARA_STATUS_FROM ?? ctx?.status?.from ?? "?";
const to = process.env.OPENCARA_STATUS_TO ?? ctx?.status?.to ?? "?";
const labels = (ctx?.issue?.labels ?? []).map((l) => l.name).filter(Boolean);
const assignees = (ctx?.issue?.assignees ?? []).map((a) => `@${a.login}`);
const prompt = ctx?.prompt ?? process.env.OPENCARA_PROMPT ?? null;

const lines = [
  `### OpenCara implementation plan (stub) :robot:`,
  ``,
  `Issue **${repo}#${num}** — _${title}_`,
  ``,
  `Status moved **${from} → ${to}**.`,
  ``,
];

if (labels.length > 0) lines.push(`Labels: ${labels.map((l) => `\`${l}\``).join(", ")}`, ``);
if (assignees.length > 0) lines.push(`Assignees: ${assignees.join(", ")}`, ``);

if (prompt) {
  lines.push(
    `<details><summary>Prompt used</summary>`,
    ``,
    `> ${String(prompt).split(/\r?\n/).join("\n> ")}`,
    ``,
    `</details>`,
    ``,
  );
} else {
  lines.push(`_No prompt linked to this agent node. Link one from the flow detail page._`, ``);
}

lines.push(
  `### Next steps (placeholder)`,
  ``,
  `1. Read the issue body and acceptance criteria.`,
  `2. Sketch a minimal implementation.`,
  `3. Open a draft PR linking back to this issue.`,
  ``,
  `_Replace this stub with a real implementer agent (e.g. \`claude --print "..."\`) via the flow node settings._`,
);

process.stdout.write(lines.join("\n") + "\n");

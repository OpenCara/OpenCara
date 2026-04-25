#!/usr/bin/env node
// Canned-stub PR reviewer used by the v1 built-in `pr-review` flow.
// Reads the context JSON on stdin and emits a markdown review on stdout.
// Swap this for `claude --print "..."` or any other agent command via the
// flow node config.

import { stdin } from "node:process";

let buf = "";
for await (const chunk of stdin) buf += chunk;

let ctx = {};
try {
  ctx = buf ? JSON.parse(buf) : {};
} catch {
  // ignore parse errors — we just emit a generic review
}

const repo = process.env.OPENKIRA_REPO ?? ctx?.pr?.base?.repo?.full_name ?? "?";
const num = process.env.OPENKIRA_PR_NUMBER ?? ctx?.pr?.number ?? "?";
const head = process.env.OPENKIRA_PR_HEAD_SHA ?? ctx?.pr?.head?.sha ?? "";
const diffLines = (ctx?.diff ?? "").split(/\r?\n/).length;

process.stdout.write(
  [
    `### OpenKira automated review (stub) :robot:`,
    ``,
    `Reviewing **${repo}#${num}** at \`${String(head).slice(0, 7)}\` — diff is ${diffLines} lines.`,
    ``,
    `_This is the v1 stub reviewer. Replace the agent node command in the flow definition to wire in a real LLM (e.g. \`claude --print\`)._`,
    ``,
  ].join("\n"),
);

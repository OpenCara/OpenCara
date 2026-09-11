# Antigravity CLI (agy)

OpenCara's `agy` kind uses the existing Apache-2.0-licensed
[shindgew/agy-acp](https://github.com/shindgew/agy-acp) adapter, verified with
`agy` 1.2.1 and `agy-acp@0.5.2-opencara.1`. It runs the installed Antigravity CLI.

On the paired device, install and sign in to `agy`, then install the
[OpenCara adapter release 0.5.2-opencara.1](https://github.com/quabug/agy-acp/releases/tag/opencara-v0.5.2-1).
The release contains a built npm package with the metadata and print-timeout
fixes; no source checkout or TypeScript build is needed:

```sh
npm install -g https://github.com/quabug/agy-acp/releases/download/opencara-v0.5.2-1/agy-acp-0.5.2-opencara.1.tgz
```

This is a versioned compatibility release from the OpenCara fork, not a
release on the upstream npm channel. Its source is commit
`cc98c7c` in `quabug/agy-acp`; the release includes a SHA-256 checksum for
the package. Upgrade existing paired devices with the same command before
deploying the server's new default arguments. To check the installed version,
run `npm list -g agy-acp` (the adapter itself starts an ACP server, including
when invoked with `--version`).

Both `agy` and `agy-acp` must be on the device daemon's PATH. OpenCara starts
`agy-acp` directly so cancellation and teardown reach the adapter instead of
an intermediate npm process.

Create an agent with kind **Antigravity CLI (agy)**, extra args
`--model gemini-3.8-flash`, and thinking level `medium`. Pin it to the device
with the CLI installed. The adapter selects the base model and reasoning
effort over ACP; it does not accept `--model` on its own command line.
`agy models` lists the available model variants.

Set a bounded working directory for chat/test runs (for example, a dedicated
empty directory on the pinned device). The adapter snapshots its working
tree before each prompt; leaving the working directory unset can make it
scan the device daemon's entire home directory.

The adapter supports streaming replies, local tools, permission requests,
and conversation resume. Its default sandbox and interactive permissions
remain enabled for ad-hoc adapter use. OpenCara passes
`--dangerously-skip-permissions` to every default `agy` adapter invocation:
the agent can read files, edit files, run commands, and fetch URLs without a
per-tool confirmation. This is required for unattended flow runs because
OpenCara cannot present agy's interactive permission UI. A custom Adapter args
override replaces this default.

OpenCara also passes `--print-timeout 30m`. Upstream `agy-acp@0.5.2` hardcodes
`agy --print-timeout 5m0s`, which interrupts an active review after five
minutes, even while tools and reasoning are progressing. The CLI then exits
zero with partial output, potentially without any final answer. The patched
adapter accepts `--print-timeout` (or `AGY_PRINT_TIMEOUT`), defaults to 30
minutes, and reports the CLI timeout diagnostic as an error instead of a
completed turn. Install the patched adapter described above before relying
on this flag; stock 0.5.2 ignores it. The fix lets the original turn finish
and does not retry an empty review.

Version 0.5.2 does not forward ACP session MCP servers, so OpenCara's
per-session MCP tools are unavailable. It also does not consume OpenCara's
custom `instructionsFile` extension. Use it for chat/local coding; flows that
require those integrations need an adapter with that support.

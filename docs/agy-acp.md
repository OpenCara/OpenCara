# Antigravity CLI (agy)

OpenCara's `agy` kind uses the existing MIT-licensed
[shindgew/agy-acp](https://github.com/shindgew/agy-acp) adapter, verified with
`agy-acp@0.5.2` and `agy` 1.1.27. It runs the installed Antigravity CLI.

On the paired device, install and sign in to `agy`, then install the adapter:

```sh
npm install -g agy-acp@0.5.2
```

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

Version 0.5.2 does not forward ACP session MCP servers, so OpenCara's
per-session MCP tools are unavailable. It also does not consume OpenCara's
custom `instructionsFile` extension. Use it for chat/local coding; flows that
require those integrations need an adapter with that support.

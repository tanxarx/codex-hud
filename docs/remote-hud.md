# Agent-link and dashboard setup

This fork follows `fwyc0573/codex-hud` and keeps the existing tmux HUD. It does
not require a patched Codex binary or changes to the agent-link daemon.

## Launch

After installing or syncing this checkout, open a new shell:

```bash
cxl                       # agent-link + detailed dashboard
cxl resume --last
cxl fork THREAD_ID
cxl --new-session         # independent client, even in the same directory
cxl -C '../other project'
```

The standalone entry is `bin/codex-hud-link`; `cxl` is its installed alias.
It starts the native daemon, calls agent-link `ensure`, and passes that proxy
to the HUD. It uses `~/Projects/agent-link/dist/cli.js` by default. Override
`AGENT_LINK_CLI_PATH` or `AGENT_LINK_NODE` for another installation. Existing
`AGENT_LINK_STATE` and `AGENT_LINK_SOCKET` settings are inherited by the CLI.
It never adds approval, sandbox, or hook-trust bypass flags.

Direct `bin/codex-hud --remote unix:///absolute/proxy.sock` launches also get
exact session binding. This covers agent-link and other local Unix WebSocket
app-server proxies. Network `ws://`/`wss://` endpoints are passed through as
before; this implementation does not fetch rollout files from remote hosts.

`cx` remains the native launch. With Codex 0.164, its default local daemon has
the same snapshot limitation as a remote daemon. Use `cxl` for a live dashboard,
or `cx --no-daemon` to keep embedded Codex and the original snapshot binding.
No global Codex setting is changed.

## Dashboard

`cxl` defaults to `CODEX_HUD_STYLE=claude` and a ten-line HUD. Features include:

- Model, reasoning effort, elapsed time, branch and dirty/sync status.
- `[WT:name]` for a linked Git worktree, with the current worktree's branch.
- GitHub owner/repository, directory, session ID and Codex version.
- Context bar and cumulative input/cache/output token counts.
- Reported account usage windows and reset countdowns, labelled by their actual
  duration. A plan reporting only a weekly window gets only that bar.
- Cache reads and hit percentage for the last response, and age of that hit.
- Approximate host RAM, configuration/skill/hook counts, tools and subagents.

```bash
CODEX_HUD_STYLE=classic cxl       # original five-line layout
CODEX_HUD_HEIGHT=12 cxl          # more room for tools and subagents
CODEX_HUD_STYLE=claude cx --no-daemon
```

RAM is an approximation of host use, not the model's memory or Codex's process
RSS. macOS uses active, wired and compressed physical pages; Linux uses
`MemAvailable` where available. Collection is cached for five seconds.

## Cache expiry

Codex rollout records expose cached-input token counts, but no cache-expiry
timestamp or retention policy. The default therefore says **expiry not
reported**. To show a reminder with an explicitly assumed lifetime:

```bash
CODEX_HUD_CACHE_TTL_SECONDS=1800 cxl  # example: a 30-minute estimate
```

The HUD labels this `~expiry ... (30m estimate)`. After the timer passes, it
says `expiry estimate elapsed`; it does not assert that the server evicted the
cache. This setting only changes the HUD. It does not request a cache lifetime,
keep a cache alive, send prompts, or alter model requests. Repeated telemetry
with unchanged usage does not restart the clock, and resuming an old session
keeps its original observed timestamp.

OpenAI caching policies vary by model and backend, and a requested lifetime
can be a minimum rather than a deletion deadline. See the
[official prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).
API token prices are not used to invent a dollar cost for a signed-in Codex
subscription.

## Binding and isolation

Each remote launch gets a private temporary directory and Unix WebSocket relay
inside Codex's protected `/tmp/codex-daemon-UID` rendezvous root. The directory
must be owned by the current user, mode 0700, and cannot be a symlink.
The relay observes successful `thread/start`, `thread/resume`, and `thread/fork`
responses from that client's connection and atomically records its exact thread
ID and rollout path. Ephemeral/title-helper threads and unrelated notifications
cannot replace the root. The HUD waits for that exact file instead of selecting
the newest session with a matching directory.

This is independent of folder names, symlinks, Git repositories and terminal
apps. It works with nested tmux and simultaneous clients in the same folder.
The relay forwards requests, responses and approval traffic; it never answers an
approval. Disconnect/unsubscribe clears the binding. Normal exit and handled
signals remove the relay directory. As with other temporary files, an unhandled
SIGKILL can leave an inert private directory until OS cleanup.

The caller's PATH, Superset terminal identity and dashboard settings are copied
onto the pane commands so an existing tmux server cannot substitute another
terminal's environment. Original native snapshot binding remains available.

## Tests and updates

```bash
npm test                       # build + Node unit/integration suite
bash tests/integration/test-default-hud-height.sh
bash tests/integration/test-installer-native-codex-entry.sh
```

The Node suite includes real WebSocket transport tests with concurrent clients,
resume/fork, reconnects, helper threads, approval forwarding, binary data, large
messages and process cleanup. Worktree tests create real Git worktrees, including
symlinked paths and directories with spaces. Tests use a canonical temp path on
macOS. Three historical oh-my-codex tests skip if that separate tool is absent.

The launcher disables upstream release prompts by default. Merge upstream
deliberately so an updater cannot replace this fork's integration:

```bash
git fetch upstream
git merge upstream/main
npm ci && npm test
git push origin HEAD:setup
```

Keep `upstream` pointing to `fwyc0573/codex-hud` and `origin` pointing to
`tanxarx/codex-hud`. The local feature branch is `local/agent-link-remote`;
the fork's `setup` branch carries these changes. Local `main` is preserved.

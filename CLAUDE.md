# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A thin launcher that runs the **Claude Code CLI** (the `claude` binary, installed separately) against non-Anthropic backends — DeepSeek, OpenRouter, Fireworks, Kimi (Moonshot), a local ChatGPT-subscription bridge (`sol`), plus RunPod-hosted models (`gemma`, `deepseek-rp`, `qwen`) — by setting<!-- [INVARIANT]: this backend list stays in sync with BACKEND_DEFS in proxy/start-proxy.js. [INVERSE_EXAMPLE]: adding a backend to the code without updating this overview violates doc parity. --> `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_DEFAULT_*_MODEL` for the child process. The repo itself ships **no application logic** — it's two shell wrappers + a Node HTTP proxy + a Cloud Run wrapper.

No package manager, no `node_modules`, no transpile step. The proxy uses Node built-ins only and is ESM (`import` syntax in `.js`, Node 18+). The Cloud Run path adds a Dockerfile but still installs nothing. The only check-in script under `tests/` is a bash probe (`phase1-runpod-endpoints.sh`) for the RunPod backends — there is no automated test suite.

> **Read [LOCKED.md](LOCKED.md) before editing `proxy/model-proxy.js`.** Specific functions (`processDeepseekRequest`, `filterThinkingBlocks`, `isLikelyDeepseekSignature`, `isLikelyAnthropicSignature`, and the `MODEL_REMAP.deepseek` keys) are append-only. Validated end-to-end on the GCE VM with 33/33 unit tests + 28-step live TUI cross-switch scenario. [INVARIANT]: backends needing special per-turn handling (like DeepSeek's thinking continuity) get their own `processXxxRequest` function; conservative Anthropic-compatible backends may ride the generic PATH C (`processOtherBackendRequest` — remap + strip-all-thinking), as openrouter/fireworks/kimi/sol do; never stuff new logic into `processDeepseekRequest`. [INVERSE_EXAMPLE]: adding kimi-specific branches inside `processDeepseekRequest`, or duplicating PATH C into a boilerplate `processKimiRequest` with no behavioral difference, both violate this rule.

## Layout

| Path | Role |
|---|---|
| [deepclaude.sh](deepclaude.sh), [deepclaude.ps1](deepclaude.ps1) | User-facing CLIs (bash + PowerShell). Two parallel implementations of the same surface — keep them in sync when changing flags or backend defs. |
| [proxy/model-proxy.js](proxy/model-proxy.js) | The HTTP proxy. Used in `--remote` mode and (when launched standalone) for live mid-session backend switching. |
| [proxy/start-proxy.js](proxy/start-proxy.js) | CLI entry to the proxy. Two modes: legacy single-backend (called by the wrappers), and standalone with live `/_proxy/mode` toggle. |
| [README.md](README.md) | User-facing docs. Source of truth for flags, slash-command examples, and the proxy port (`3200`). |

## Architecture

### Two run modes

1. **Direct launch** (`deepclaude` / `deepclaude -b or` / etc.) — wrapper just sets env vars and `exec`s `claude`. No proxy involved. The backend's Anthropic-compatible endpoint receives requests directly.

2. **Remote-control launch** (`deepclaude --remote`) — the bridge WebSocket (`wss://bridge.claudeusercontent.com`) is hardcoded by Claude Code and needs Anthropic OAuth, but model calls are configurable. The wrapper:
   - Spawns [proxy/start-proxy.js](proxy/start-proxy.js) on `127.0.0.1:3200` (auto-increments to +20 if busy).
   - Sets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` and the `ANTHROPIC_DEFAULT_*_MODEL` vars, but **does not** set `ANTHROPIC_AUTH_TOKEN` (OAuth handles bridge auth).
   - The proxy splits traffic: `/v1/messages` → backend (with the backend's API key); everything else → `api.anthropic.com` passthrough.
   - On exit the wrapper kills the proxy via trap (bash) or `try/finally` (PowerShell).

### What the proxy actually does

[proxy/model-proxy.js](proxy/model-proxy.js) is the only non-trivial code in the repo. Three concerns drove its current shape — break any of them and Claude Code crashes mid-loop:

- **`UsageNormalizer` Transform stream** ([model-proxy.js:40](proxy/model-proxy.js#L40)) — DeepSeek/OpenRouter SSE may omit `usage` from `message_start` / `message_delta`. Claude Code's parser dereferences `$.input_tokens` unconditionally and crashes on undefined. The transform parses each SSE event and injects zero-valued `usage` if missing. Same fix for non-stream JSON via `normalizeJsonBody`.
- **Thinking-block stripping** ([model-proxy.js:107-123](proxy/model-proxy.js#L107-L123), applied at [model-proxy.js:337-354](proxy/model-proxy.js#L337-L354)) — non-Anthropic backends reject *any* `thinking` content blocks (signed or not). After a non-Anthropic session, switching back to Anthropic still trips 400s because foreign backends can generate signed-but-invalid blocks. The live rule is STATELESS, per-request, signature-shape based (no session flags): PATH C (other backends) strips ALL thinking blocks; PATH A (Anthropic) clean-break-strips ALL when any foreign-shaped signature is present (deepseek-shaped `<80` chars, or the sol bridge's `ccp:` prefix — classifiers at [model-proxy.js:207-219](proxy/model-proxy.js#L207-L219)), else keeps anthropic-sig blocks and drops unsigned ones ([model-proxy.js:270-305](proxy/model-proxy.js#L270-L305)). <!-- [INVARIANT]: this description matches the stateless signature-shape implementation; there is NO hadNonAnthropicSession flag in live code. [INVERSE_EXAMPLE]: re-documenting a session-state flag that does not exist violates doc parity. --> Don't "simplify" this — both branches are load-bearing.
- **Model-name remap** ([model-proxy.js:10-25](proxy/model-proxy.js#L10-L25), applied at [model-proxy.js:319-329](proxy/model-proxy.js#L319-L329)) — Claude Code sends literal Anthropic model IDs (`claude-opus-4-7` etc.). The proxy rewrites them to backend-native IDs (`deepseek-v4-pro`, `deepseek/deepseek-v4-pro`) before forwarding. Add new Claude model IDs here when Anthropic releases them.

### Control endpoints (`/_proxy/*`)

Live on the same port as model traffic. Slash commands (`/deepseek`, `/anthropic`, `/openrouter`) `curl` these from inside the running Claude Code session — that's how mid-session switching works.

| Endpoint | Method | Purpose |
|---|---|---|
| `/_proxy/status` | GET | `{ mode, uptime, requests }` |
| `/_proxy/cost` | GET | per-backend token totals + Anthropic-equivalent + savings |
| `/_proxy/mode` | POST | `backend=<name>` body switches the active route |

`/_proxy/mode` checks `Origin` and rejects non-localhost callers (3200 is loopback-only via `listen(port, '127.0.0.1')`, but the origin check is defense-in-depth against rebinding).

The path-overlap stripping at [model-proxy.js:282-291](proxy/model-proxy.js#L282-L291) exists because OpenRouter's base path is `/api/v1` and Claude Code sends `/v1/messages` — naive concat yields `/api/v1/v1/messages`. Don't change without re-testing OpenRouter.

### Anthropic-compatible endpoints per backend

These URLs differ from each provider's standard OpenAI-style endpoints — they're the Anthropic-shaped passthroughs:

| Backend | URL | Auth header |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/anthropic` | `x-api-key` |
| OpenRouter | `https://openrouter.ai/api/v1` (or `/api` from wrappers — note the inconsistency) | `Authorization: Bearer` |
| Fireworks | `https://api.fireworks.ai/inference/v1` | `Authorization: Bearer` |
| Kimi (Moonshot) | `https://api.moonshot.ai/anthropic` | `Authorization: Bearer` (`bearer: true`; endpoint also tolerates `x-api-key`) |
| Sol (local claude-code-proxy bridge) | `http://127.0.0.1:18765` | none — keyless (`requiresKey: false`); the bridge holds its own ChatGPT OAuth |

<!-- [INVARIANT]: new backends declare auth via the explicit `bearer` flag in BACKEND_DEFS; the URL-substring match is only the legacy fallback. [INVERSE_EXAMPLE]: relying on the URL substring for a new backend (the silent-401 trap) violates this rule. -->
`useBearer` is decided by the per-backend `bearer` flag in `BACKEND_DEFS` ([start-proxy.js:4](proxy/start-proxy.js#L4), [cloud-run.js:3](cloud-run.js#L3)) when present; otherwise it falls back to URL substring match on `openrouter` / `fireworks` ([model-proxy.js:436](proxy/model-proxy.js#L436)). Always set `bearer` explicitly for new backends — the substring fallback is the historic silent-401 trap.

## Common operations

```bash
# Run the proxy standalone (no claude wrapper) for testing
node proxy/start-proxy.js                              # default mode=anthropic, port=3200
node proxy/start-proxy.js --mode deepseek --port 3201

# Manually switch a running proxy
curl -sX POST http://127.0.0.1:3200/_proxy/mode -d 'backend=deepseek'
curl -s http://127.0.0.1:3200/_proxy/status
curl -s http://127.0.0.1:3200/_proxy/cost

# Launch wrappers
./deepclaude.sh                       # DeepSeek default
./deepclaude.sh --backend or          # OpenRouter
./deepclaude.sh --remote              # remote-control mode (spawns proxy)
./deepclaude.sh --benchmark           # latency probe across backends with keys

# PowerShell equivalent
.\deepclaude.ps1                      # same flags, see top of file
```

There are no automated tests. Verify by running the proxy and exercising it with `curl` or by launching `deepclaude` and watching `[MODEL-PROXY]` log lines.

## When editing

- **Keep `deepclaude.sh` and `deepclaude.ps1` in lockstep.** Adding a flag, backend, or model name to one without the other is the most common bug source. Every backend block (`ds` / `or` / `fw` / `ki` / `sol`) appears in both files plus in `BACKEND_DEFS` in [proxy/start-proxy.js:4](proxy/start-proxy.js#L4) plus in the separate `BACKEND_DEFS` in [cloud-run.js:3](cloud-run.js#L3) (sol intentionally absent there — a localhost bridge is unreachable from Cloud Run) plus in `MODEL_REMAP` and `PRICING_PER_M` in [proxy/model-proxy.js:10](proxy/model-proxy.js#L10) — six places. Grep all six before declaring a backend "added."<!-- [INVARIANT]: the registration count here matches the actual number of BACKEND_DEFS/MODEL_REMAP/PRICING sites in the tree. [INVERSE_EXAMPLE]: leaving this at "five places" after cloud-run.js gained its own BACKEND_DEFS violates doc parity. -->
- **Don't introduce dependencies.** The whole proxy uses Node built-ins only (`http`, `https`, `url`, `stream`). No `package.json`, no `node_modules`. Keep it that way — users `git clone` and run.
- **The thinking-block and usage-normalization branches all exist because of real Claude Code crashes.** The commit messages (`fix: strip thinking blocks on backend switch`, `fix: sync model proxy — exact path matching, usage normalization`) document the incidents. Don't refactor these as "dead code."
- **Tracked file weirdness in the repo root** — files named `.end(JSON) unconditionally.`, `hares the same proxy ancestry as this repo.`, etc., are stray text fragments (they appear in `git status` as untracked). Don't commit them; they look like editor save accidents. Confirm with the user before deleting.

## Out of scope for this repo

- Modifying the `claude` CLI itself (it's an external npm package — `@anthropic-ai/claude-code`).
- Adding MCP / agent-skills features — this repo is just the launcher, those live in `~/.claude/`.

# Plan: add `kimi` (Kimi K3) and `sol` (GPT-5.6 Sol via ChatGPT subscription) backends

Plan-first Phases 2–6. **Rev 2** — incorporates 19 CONFIRMED findings from a
25-agent adversarial review (5 lenses → merge → per-finding verification, 0
refuted). Phase 1 research: 3-agent fan-out (repo map, official Kimi docs,
GPT-5.6/Codex-bridge landscape). User decisions locked in:

1. Kimi key type: **pay-per-token** (platform.kimi.ai) → `https://api.moonshot.ai/anthropic`, Bearer auth.
2. Sol path: **raine/claude-code-proxy** local bridge (ChatGPT-seat OAuth via official Codex flow, Anthropic Messages API on `127.0.0.1:18765`).
3. Auth selection: **explicit per-backend `bearer` flag**; substring fallback kept for existing backends.
4. Cloud Run: **register kimi** (no deploy). Sol is localhost-only → NOT in Cloud Run.
5. Dispatcher convention (review C15): **DECISION PENDING** — PATH C reuse vs dedicated `processXxxRequest` (see Phase 3 §7).
6. Tier-suffix handling (review C10): **DECISION PENDING** — PATH C suffix strip vs explicit `[1m]` keys (see Phase 3 §5).

> **PRE-COMMIT SECURITY GATE (review C6):** `docs/rc-fallback-and-audit-handoff.md:134`
> contains a plaintext `KIMI_API_KEY` on disk (file is untracked). Before ANY commit:
> (1) redact that line; (2) rotate the key at platform.kimi.ai; (3) stage files
> explicitly by name — never `git add docs/` / `git add -A`; (4) verify
> `git diff --cached | grep -ci "sk-\|KIMI_API_KEY="` returns 0 secrets staged.

---

## Phase 2 — REQUIREMENTS

| ID | Requirement | Acceptance criteria |
|---|---|---|
| REQ-001 | `deepclaude -b ki` / `-b kimi` (sh + ps1) launches routed to Kimi K3 | Works on BOTH wrappers incl. the long alias (ps1 needs alias normalization — see Phase 4); `[MODEL-PROXY]` shows `api.moonshot.ai`; missing `KIMI_API_KEY` → actionable error naming the var |
| REQ-002 | Proxy `backend=kimi` routes `/v1/messages` to `https://api.moonshot.ai/anthropic` with `Authorization: Bearer $KIMI_API_KEY` | `mode:kimi` in status; auth form proven by ORACLE: 200 with Bearer, 401 control-probe with x-api-key (proxy has no auth-header logging by design) |
| REQ-003 | `MODEL_REMAP.kimi` maps every ID the wrappers/CLI emit → `kimi-k3`, incl. tier-suffixed `claude-*[1m]` forms per decision #6 | Remapped model in forwarded body; no 400 from Moonshot; T-02b covers the 1M-tier form |
| REQ-004 | `deepclaude -b sol` launches routed to `http://127.0.0.1:18765`; the keyless launch still takes the LEGACY proxy path (port detected) | Preflight reachability check; bridge down → error with install/run instructions; wrapper prints `Proxy on :<port>` — never "Proxy failed to start" (start-proxy.js `:14` gate fix, C1) |
| REQ-005 | Keyless backends: defs support `requiresKey: false`; switchMode allows; inbound `authorization`/`x-api-key` STRIPPED on **`/v1/messages` only** via closure lookup `allBackends[state.mode]?.requiresKey === false` (never `state.*`, never `!state.apiKey`) | Switch succeeds with no SOL env var; bridge-side header inspection (its request log or a loopback echo listener) shows no inbound auth; sol-mode NON-model Anthropic passthrough keeps OAuth header (T-20) |
| REQ-006 | Protocol-aware forwarding: `http:` vs `https:` module + 80/443 port fallback | `sol` request completes over plain HTTP; T-13/T-14/T-21 regressions green |
| REQ-007 | Explicit `bearer` flag drives proxy auth AND ps1 benchmark; absent flag → existing fallbacks unchanged (proxy: URL-substring `openrouter`/`fireworks`; ps1 benchmark: ID list `@("or","fw")` — two DIFFERENT fallback shapes, both preserved verbatim) | kimi sends Bearer; ds x-api-key; or/fw unchanged |
| REQ-008 | `/_proxy/cost`: kimi $3.00/M in, $0.30/M cache-hit, $15.00/M out; sol $0 | Cost math spot-checked vs known token counts |
| REQ-009 | `~/.claude/commands/kimi.md` + `sol.md` (clones of `deepseek.md`) | `/kimi`, `/sol` switch live sessions; sol.md notes "bridge must be running" |
| REQ-010 | `--benchmark` includes kimi; sol runs iff bridge preflight passes, else prints explicit `sol: SKIP (bridge not running)` — requires reworking BOTH wrappers' keyless-skip guards (sh `:185`, ps1 `:199`), which would otherwise auto-skip sol with the wrong message before any probe | kimi row; sol row or the exact skip line; keyed backends keep existing "SKIP (no key)" |
| REQ-011 | Cloud Run: `cloud-run.js` defs + `switch-model.ps1` gain kimi (NOT sol); `cloud-run.js:14` loop must THREAD `bearer`/`requiresKey` (it currently copies only url+apiKey — C2) | Local `node cloud-run.js` boot: switch to kimi → forwarded auth is Bearer (T-18); no deploy |
| REQ-012 | Docs: README (env row, backends table, Kimi + Sol setup incl. bridge install/auth/run, ToS-tolerated note, Sol-on-Plus caveat, cost note), lexicon Env Vars row | Sections updated |
| REQ-013 | sh/ps1 lockstep for EVERY touchpoint, now incl.: `launch_remote` initial switch, ps1 centralized key checks, ps1 alias map, benchmark guards, error/help/usage text lists | Parity checklist all-green |

### Edge cases

| Input | Normal | Empty/unset | Wrong value | Boundary/weird |
|---|---|---|---|---|
| `-b` name | `ki`, `kimi`, `sol` | defaults `ds` | unknown → error listing valid set (ALL lists updated: sh `:73`/`:165`, ps1 `:288` + `:237` which today prints no list — add one) | mixed case: wrappers DIVERGE today — sh `case` is case-sensitive, ps1 hashtable lookup is case-insensitive (C18). Documented as pre-existing non-parity; NOT silently "fixed" |
| `KIMI_API_KEY` | valid | wrapper hard error; proxy `API key not set for kimi` | invalid → upstream 401 surfaced | whitespace not trimmed (existing behavior, documented) |
| Bridge (sol) | up on 18765 | down → preflight error / clean 502 | wrong service on 18765 → surfaced error | restart mid-session → next request 502s, session survives |
| Model at proxy, kimi mode | `claude-opus-4-7` → `kimi-k3` | — | unmapped foreign ID passes through → Moonshot 400 surfaced | tier-suffixed `claude-opus-4-7[1m]` (real 1M-tier sessions): PATH C has NO suffix strip today — handled per decision #6. `kimi-k3[1m]` key covers manual `/model` entry only |
| SSE `usage` | present | missing → `UsageNormalizer` injects zeros | — | — |
| `thinking` cross-switch | PATH C strips ALL on requests TO kimi/sol | — | — | Switch-back to anthropic is STATELESS + signature-shape based (`processAnthropicRequest`, model-proxy.js:183-188): clean-break-strips ALL only if some signature < 80 chars; sigs ≥ 80 chars are kept and forwarded → potential 400. Responses are never stripped, so kimi/sol thinking persists in history. MUST be probed live (T-01a/T-05a) — the classifiers are LOCKED; any remediation lives in un-locked `processAnthropicRequest` |

### Out of scope (sacred)
- Bridge lifecycle management (docs only; no auto-spawn/install).
- `gpt-5.6-terra`/`luna` slots; any Cloud Run deploy.
- Pre-existing quirks — noted, NOT touched: `qwen` ghost backend; RunPod `_single` pricing; `or` URL `/api` vs `/api/v1`; `bindHost` ignored; `set_model_env` haiku ID vs dated remap key (LOCKED); sh-vs-ps1 case-sensitivity divergence (C18); sh benchmark's x-api-key-for-all on or/fw arms.
- LOCKED regions: `processDeepseekRequest`, 3 helpers, existing `MODEL_REMAP.deepseek` keys.

### Dependencies
`startModelProxy` consumers: `start-proxy.js` (both modes), `cloud-run.js` — BOTH loops must thread new fields (C2). Backend-def shape gains optional `bearer`/`requiresKey`; fallback behavior identical **only with the keyed-count `hasBackends` guard** (C9, Phase 4). Forwarding change affects ALL backends → T-13/T-14/T-21 mandatory.

---

## Phase 3 — ARCHITECTURE

### Backend definitions

```js
// proxy/start-proxy.js BACKEND_DEFS (+2)
kimi: { url: 'https://api.moonshot.ai/anthropic', keyEnv: 'KIMI_API_KEY', bearer: true },
sol:  { url: 'http://127.0.0.1:18765', keyEnv: null, requiresKey: false, bearer: false },
// cloud-run.js BACKEND_DEFS (+1): the kimi line only
```

### Contract changes in `proxy/model-proxy.js` (additive; none in LOCKED regions)

1. **`allBackends` (~:401-410):** `useBearer: cfg.bearer ?? (cfg.url.includes('openrouter') || cfg.url.includes('fireworks'))` — `??` (not `||`) so `bearer: false` is honored; plus `requiresKey: cfg.requiresKey !== false`.
2. **`switchMode` (~:501-503):** `if (!b.apiKey && b.requiresKey)` → keyless sol allowed; keyed errors unchanged.
3. **Auth strip for keyless backends (C7+C8):** a SIBLING branch of the existing `MODEL_PATHS.includes(urlPath) && state.apiKey` block (cannot nest — sol's apiKey is null). Condition: `MODEL_PATHS.includes(urlPath) && allBackends[state.mode]?.requiresKey === false` → delete inbound `authorization` + `x-api-key`, inject nothing. Closure lookup, NOT `state.requiresKey` (no state-assignment site exists — a state read would be permanently undefined = dead branch silently leaking OAuth). The `MODEL_PATHS` scope is load-bearing: sol-mode non-model traffic still passes through to api.anthropic.com carrying the client's OAuth header (:649-652, :604) — an unscoped strip 401s it. Anthropic-safe: `allBackends` never contains an `anthropic` entry, so `undefined === false` keeps OAuth passthrough intact; also covers `--mode sol` boots that never call switchMode.
4. **Protocol-aware forwarding (~:697+):** `import { request as httpRequest } from 'http'` (Node built-in — no dependency added); select module + default port by `dest.protocol`.
5. **`MODEL_REMAP` (+2 tables, additive)** — targets `kimi-k3` / `gpt-5.6-sol` for the canonical ID set (`claude-opus-4-6/-4-7`, `claude-sonnet-4-6`, `claude-sonnet-4-5-20250929`, `claude-haiku-4-5`, `claude-haiku-4-5-20251001`) plus `'kimi-k3[1m]': 'kimi-k3'` (manual `/model` entry only). **Decision #6 (tier-suffix, C10):** real 1M-tier sessions emit `claude-opus-4-7[1m]`-class IDs which PATH C neither strips nor remaps → 400. Options: **(a) Recommended** — one additive hunk at the top of `processOtherBackendRequest` mirroring PATH A's existing regex (`parsed.model = parsed.model.replace(/\[\d+[mk]\]$/i, '')` before remap lookup; also fixes the same pre-existing gap for openrouter/fireworks); (b) explicit `[1m]` keys per table; (c) scope out — then REQ-003 + edge-case table must state "1M-tier sessions unsupported in kimi/sol mode (pre-existing PATH C limitation)".
6. **`PRICING_PER_M` (+2):** `kimi: { input: 3.00, output: 15.00, cacheHit: 0.30 }`, `sol: { input: 0, output: 0 }`.
7. **Dispatcher (~:689-695): NO change proposed** — both ride PATH C like openrouter/fireworks/RunPod, as the PATH C comment anticipates. **Decision #5 (C15): this DEVIATES from the letter of LOCKED.md ("New backend? Add a new processXxxRequest…") and CLAUDE.md ("New backends MUST go in their own processXxxRequest function") — both written unconditionally.** Options: **(a) Recommended** — PATH C reuse; the SAME PR amends CLAUDE.md's MUST sentence + LOCKED.md's "How to extend" bullet to the conditional rule ("backends needing special per-turn handling get a dedicated processXxxRequest; conservative backends may ride PATH C"); (b) thin `processKimiRequest`/`processSolRequest` wrappers delegating to PATH C logic.

### Error handling
Kimi 401/429 (Tier-0: 3 RPM) → existing upstream passthrough; README documents tiers. Bridge down → wrapper preflight (3s timeout) at launch; mid-session → existing proxyRes error handler (clean 502, SSE-safe). `switchMode('sol')` with bridge down succeeds (mode is config, not connection) — first request surfaces it; sol.md says so.

---

## Phase 4 — DETAILED DESIGN (predicted diffs; line anchors re-verified at edit time)

```
MODIFY proxy/start-proxy.js
  +2 BACKEND_DEFS entries. STANDALONE loop: include keyless defs
  (guard `def.keyEnv ? process.env[def.keyEnv] : null`). LEGACY loop:
  also include requiresKey:false defs, BUT count only KEYED backends for
  hasBackends — `Object.values(backends).some(b => b.apiKey)` — so a
  launch with zero ds/or/fw keys still boots '_single' custom-target
  mode (C9: otherwise sol's presence flips hasBackends true and reroutes
  documented custom-target boots to api.anthropic.com). Legacy gate :14
  `if (targetUrl && apiKey)` → `if (targetUrl)` with
  `apiKey: apiKey || 'unused'` (cloud-run.js:21 precedent) — otherwise a
  keyless sol launch falls into the STANDALONE branch, prints a banner
  instead of the bare port line, and BOTH wrappers' port detection fails
  (C1). Thread bearer/requiresKey into the backends maps.   ~14 lines

MODIFY proxy/model-proxy.js
  + http import (:1-4)                                        ~1 line
  + MODEL_REMAP.kimi/.sol (:10-25) per Phase 3 §5             ~16 lines
  + PATH C tier-suffix strip in processOtherBackendRequest
    (decision #6a; additive first hunk of the function)       ~2 lines
  + PRICING_PER_M.kimi/.sol (:27-33)                          ~2 lines
  ~ allBackends: bearer ?? substring, requiresKey (:401-410)  ~4 lines
  ~ switchMode key check (:501-503)                           ~1 line
  ~ auth: sibling keyless-strip branch, closure lookup +
    MODEL_PATHS scope (:653-661) per Phase 3 §3               ~6 lines
  ~ forward opts: protocol-aware module + port (:697-720)     ~6 lines
  NOT TOUCHED: processDeepseekRequest + helpers, MODEL_REMAP.deepseek
  keys, dispatcher, UsageNormalizer.

MODIFY deepclaude.sh
  + usage comment (:3) + KIMI_URL/SOL_URL config (:10-12)     ~3 lines
  + resolve_backend arms (:46-74): `ki|kimi)` — key check, url, IDs
    `kimi-k3` (NOT kimi-k3[1m]: RESOLVED_* are banner-display-only,
    read solely at :252, and must equal the remap target — C13);
    `sol)` — NO key check, RESOLVED_KEY='unused' placeholder ONLY if
    the wrapper-side mechanism is chosen over the :14 gate fix (pick
    ONE, apply identically in ps1 — C1), bridge preflight curl
    --max-time 3, url http://127.0.0.1:18765, IDs `gpt-5.6-sol`;
    unknown-backend list (:73) += ki, kimi, sol               ~26 lines
  + do_switch aliases + error list (:158-172)                 ~3 lines
  + launch_claude initial-switch arms (:245-249): patterns MUST be
    `ki|kimi)` / `sol)` — $BACKEND is the raw user string; a short-only
    arm silently skips the switch (C11)                       ~2 lines
  + launch_remote initial-switch (C4): mirror :245-249 with a generic
    POST for ALL non-anthropic backends — pre-existing hole: sh
    --remote today NEVER switches (ds/or/fw included); ps1 already
    does via :133-141                                         ~4 lines
  ~ benchmark (:174-200, C12): names list += kimi, sol; keyless-skip
    guard (:185) bypassed for sol → 3s bridge preflight; reachable →
    probe with NO auth header, else `sol: SKIP (bridge not running)`;
    auth header parametrized per-arm (ds x-api-key; or/fw unchanged
    x-api-key [pre-existing, out of scope]; kimi Bearer; sol none);
    kimi arm model=kimi-k3                                    ~16 lines
  + status/cost/help rows (:98-108, 128-131, 143-155)         ~8 lines

MODIFY deepclaude.ps1
  ~ .USAGE header (:5-14)                                     ~2 lines
  + $KimiKey resolution (:40-51)                              ~3 lines
  + $Providers.ki / .sol (:53-75): clone FULL entry shape INCLUDING
    backendId="kimi"/"sol" (load-bearing: :133-141 posts the initial
    mode switch keyed on it — omit it and the proxy silently stays in
    legacy boot, C14) and opus/haiku = `kimi-k3` / `gpt-5.6-sol`
    (LOAD-BEARING in ps1 benchmark :206, unlike sh — C13); new fields:
    bearer=$true/$false; sol: requiresKey=$false, key='unused' iff
    wrapper-side C1 mechanism chosen                          ~18 lines
  + alias normalization before BOTH provider lookups (:236, :287):
    `$AliasMap = @{ kimi='ki' }` minimum (REQ-001 promises -b kimi;
    $Providers lookup is exact — C11); extending to ds/or/fw optional
  ~ centralized key checks (:238 remote, :289 non-remote):
    `if (-not $p.key -and $p.requiresKey -ne $false) { ... exit 1 }`
    — sol passes keyless; keyed unchanged (C5)                ~2 lines
  + sol bridge preflight in BOTH launch paths (:236-246, :287-298) via
    a shared Test-SolBridge helper — ps1 has no shared resolver, unlike
    sh where resolve_backend covers both (C5)                 ~12 lines
  ~ benchmark (:194-219, C12): foreach += ki, sol; keyless guard (:199)
    respects requiresKey; sol preflight → run-or-SKIP line; auth:
    `$useBearer = if ($null -ne $p.bearer) { $p.bearer }
                  else { $id -in @("or","fw") }`              ~8 lines
  ~ error lists + help (C17): non-remote (:288), remote (:237 — add a
    valid-list, today prints none), help backends (:185) and slash line
    (:189) += /kimi /sol                                      ~4 lines
  + status/cost rows (:151-159, 171-174)                      ~4 lines

MODIFY cloud-run.js    + kimi entry; thread bearer/requiresKey through
                       the :14 loop: { url, apiKey, bearer: def.bearer,
                       requiresKey: def.requiresKey } (C2)    ~3 lines
MODIFY switch-model.ps1  + kimi alias + menu row + unknown-model error
                       list (:5-31, :49) (C19)                ~3 lines
MODIFY CLAUDE.md + LOCKED.md  conditional new-backend rule per decision
                       #5a (C15)                              ~4 lines
MODIFY docs/rc-fallback-and-audit-handoff.md  REDACT :134 key line
                       (pre-commit gate; key rotation is user's action)
CREATE ~/.claude/commands/kimi.md / sol.md                    ~17 lines
MODIFY README.md       env row, backends table, Kimi + Sol setup
                       (bridge install/auth/run, ToS note, Sol-on-Plus
                       caveat), slash snippets, cost note ("kimi list
                       price ≈ Anthropic list; savings come from
                       cache-hit discount")                   ~60 lines
MODIFY docs/lexicon.md Env Vars stub: + KIMI_API_KEY          ~2 lines
```

Anti-pattern check: no silent failures (benchmark skips print; keyless is an
explicit flag; hasBackends guard prevents the silent `_single`→anthropic
reroute); auth rule copies REDUCED (ps1 benchmark now reads the flag); strip
branch keyed on explicit `requiresKey === false` closure lookup — never a
dead `state.*` read; preflight 3s < 5-min proxy timeout; no new module state;
errors name the env var / bridge URL; no new dependencies.

---

## Phase 5 — TEST PLAN (manual curl/live harness; repo has no automated suite)

| ID | REQ | Test | Expected |
|---|---|---|---|
| T-01 | 002 | Direct probe `api.moonshot.ai/anthropic/v1/messages`, Bearer, `kimi-k3`, stream | 200; record whether `message_start` carries `usage` |
| T-01a | C3 | Inspect kimi streaming + non-streaming responses for `thinking` blocks: presence, signature format, signature LENGTH | If any sig ≥ 80 chars → anthropic switch-back clean-break will NOT trigger → escalate BEFORE T-10 (fix must live in un-locked processAnthropicRequest) |
| T-02 | 003 | Same probe, model `kimi-k3[1m]` | Record accept/reject → validates the manual-entry remap key |
| T-02b | 003 | Standalone proxy, backend=kimi, model `claude-opus-4-7[1m]` | Forwarded body `kimi-k3` (tier suffix handled per decision #6), 200 |
| T-03 | 002,007 | backend=kimi, model `claude-opus-4-7` | 200 proves Bearer (ORACLE: control probe with x-api-key must 401); body remapped |
| T-04 | 001 | Unset KIMI_API_KEY, both wrappers + proxy switch | Wrapper names `KIMI_API_KEY`; proxy: `API key not set for kimi` |
| T-05 | 004,005,006 | Bridge up → backend=sol → request | 200 over plain HTTP; body `gpt-5.6-sol`; NO inbound auth at the bridge — verified AT THE BRIDGE (its request log, or point sol.url at a loopback echo listener); proxy-side logs can't prove a dead strip branch |
| T-05a | C3 | Same as T-01a for bridge responses | Same escalation rule |
| T-06 | 004 | Bridge down: launch + switch-then-request | Preflight error with instructions; clean 502, session survives |
| T-07 | 005 | backend=sol with no SOL env vars | Switch succeeds (requiresKey:false) |
| T-08 | 008 | `GET /_proxy/cost` after T-03/T-05 | kimi 3/0.30/15; sol 0; totals plausible |
| T-09 | 009 | `/kimi` then `/sol` live | Modes switch; model self-identifies correctly |
| T-10 | 009 | Cross-switch kimi → anthropic → deepseek → kimi. PRECONDITION: `ANTHROPIC_API_KEY` set (switchMode refuses anthropic otherwise, :488-490) | No 400 — verified EMPIRICALLY, contingent on T-01a/T-05a signature findings (no `hadNonAnthropicSession` mechanism exists in live code) |
| T-11 | 010 | `--benchmark` bridge up / bridge down / no KIMI key | kimi row; `sol: SKIP (bridge not running)` when down; `kimi: SKIP (no key)` when unset |
| T-12 | 013 | Every flag/switch on BOTH wrappers | Identical behavior; banner + benchmark model IDs equal MODEL_REMAP targets; `/_proxy/status` shows mode kimi/sol right after launch (guards ps1 backendId switch) |
| T-13 | 006 REG | Full DeepSeek switch cycle + live request after http change | Unchanged (protects LOCKED PATH B) |
| T-14 | 006 REG | Anthropic OAuth passthrough (remote smoke) | Auth forwarding unchanged |
| T-15 | — | `node --check` on .js; ps1 parse; `bash -n` | All parse |
| T-16 | Sol | Verify `gpt-5.6-sol` served under the user's ChatGPT plan via bridge (issue #31905) | If 400 "not supported with ChatGPT account" → surface; fallback (terra? API key?) is USER's decision |
| T-17 | 004 | `deepclaude -b sol` bridge up, both wrappers | `Proxy on :<port>` printed — legacy path taken, port detected (C1) |
| T-18 | 011 | Local `node cloud-run.js`, KIMI_API_KEY set, switch backend=kimi | Forwarded auth `Authorization: Bearer`, NOT x-api-key (C2) |
| T-19 | 001,004,013 | `--remote -b ki` and `--remote -b sol`, both wrappers | `mode:kimi`/`mode:sol` BEFORE first model call; log shows moonshot / 127.0.0.1:18765, never api.anthropic.com (C4) |
| T-20 | 005 REG | sol mode in a remote OAuth session → NON-/v1/messages request | Upstream to api.anthropic.com keeps client's authorization header (no 401) (C8) |
| T-21 | REG | Legacy `node proxy/start-proxy.js <custom-url> <key>` with NO ds/or/fw keys | Boots `_single`; traffic to <custom-url> with <key>, NOT api.anthropic.com (C9) |

---

## Phase 6 — RISK ASSESSMENT

| Component | Can fail when | Detection | Recovery | Blast radius |
|---|---|---|---|---|
| Secret leak | stray KIMI_API_KEY in docs/ swept into a commit | pre-commit grep gate (header) | redact + ROTATE key | blocks all commits until clean |
| Kimi auth | endpoint rejects our Bearer form | T-01/T-03 oracle | flip per-backend flag | kimi only |
| Kimi model ID | `[1m]`/tier handling differs | T-02/T-02b | remap/strip adjust | kimi only |
| Kimi SSE usage | usage omitted (undocumented) | T-01 | UsageNormalizer exists | none |
| HTTP forwarding | regression on HTTPS backends | T-13/T-14/T-21 | single choke point, revert hunk | ALL backends — highest care |
| hasBackends flip | sol's keyless presence reroutes `_single` custom-target boots | T-21 | keyed-count guard (C9) | RunPod/custom users |
| Keyless strip | fires outside MODEL_PATHS or in anthropic OAuth mode; or dead (state.* read) | T-14 + T-20 + bridge-side T-05 | closure lookup + MODEL_PATHS scope (C7/C8) | remote mode |
| Thinking switch-back | kimi/sol sigs ≥ 80 chars evade LOCKED classifier → 400 on anthropic | T-01a/T-05a before T-10 | remediation in un-locked processAnthropicRequest; escalate to user | cross-switch UX |
| Bridge (sol) | down / restarts / upstream blocks | preflight + 502 path | restart bridge | sol only |
| Sol-on-Plus | Codex account restriction | T-16 | USER decision gate — no silent fallback | sol only |
| Lockstep drift | one wrapper missed (now incl. remote path, aliases, guards) | T-12/T-19 + parity checklist | fix before done | UX |
| LOCKED violation | accidental edit in locked regions | diff review vs LOCKED.md pre-commit | — | validated DeepSeek path |

Rollback: single commit `git revert`; slash-command files are user-dir
additions (delete to roll back). No schema/state migration.

Security: keys in env vars only, masked by `mask_key`; pre-commit secret gate
(header) — the stray key file is redacted in this change and the key rotated
by the user; inbound-auth strip scoped to `/v1/messages` for keyless backends
prevents OAuth leak to the bridge without breaking Anthropic passthrough;
loopback-only listen + Origin check unchanged. ToS: OpenAI publicly tolerates
third-party harnesses on subscription seats (not contractual) — README
documents this; user accepted the path explicitly.

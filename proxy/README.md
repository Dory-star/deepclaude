# Model Proxy for Remote Control

When using `claude remote-control`, the bridge authentication must go to Anthropic while model API calls go to DeepSeek. This proxy handles the split.

## How it works

```
claude remote-control
  ├── Bridge WebSocket → wss://bridge.claudeusercontent.com (Anthropic, hardcoded)
  └── Model API calls  → http://localhost:3200 (this proxy)
                            ├── /v1/messages → api.deepseek.com (with DeepSeek key)
                            └── everything else → api.anthropic.com (passthrough)
```

## Usage

```javascript
import { startModelProxy } from './model-proxy.js';

const proxy = await startModelProxy({
    targetUrl: 'https://api.deepseek.com/anthropic',
    apiKey: process.env.DEEPSEEK_API_KEY,
});

console.log(`Proxy on port ${proxy.port}`);

// Set env vars for claude remote-control:
// ANTHROPIC_BASE_URL=http://127.0.0.1:${proxy.port}
// ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-flash
// (do NOT set ANTHROPIC_AUTH_TOKEN — OAuth handles bridge auth)

// When done:
proxy.close();
```

## Why a proxy?

Claude Code's remote control uses two separate channels:
1. **Bridge** (WebSocket to `wss://bridge.claudeusercontent.com`) — hardcoded, needs Anthropic OAuth
2. **Model API** (HTTP to `ANTHROPIC_BASE_URL`) — configurable

Setting `ANTHROPIC_AUTH_TOKEN` to a DeepSeek key breaks the bridge. The proxy lets you keep Anthropic OAuth for the bridge while routing model calls to DeepSeek.

## Wire-patches voor third-party backends

DeepSeek's Anthropic-endpoint is strenger dan Anthropic zelf; twee Claude
Code-eigenaardigheden zijn daarom op de wire gepatcht. Beide zitten in
`model-proxy.js`, gelden alleen voor model-calls (anthropic-mode blijft
volledig transparant) en raken de client-historie niet.

| Patch | Wat het doet | Waarom |
|---|---|---|
| `sanitizeToolSchemas` | `\0` → `\x00` in `pattern`-waarden van tool-schema's | Artifact-tool; DeepSeek weigert de `\0`-regex-escape (24 sep 2026) |
| `sanitizeInlineToolBlocks` + `stripInlineToolsBeta` | `tool_addition`/`tool_removal` met een niet-`tool_reference` tool → `tool_reference` (of gedropt); bèta-token `inline-tools-*` uit de header | Claude Code's inline-tools-bèta stuurt `tool_definition`-blokken die DeepSeek niet kent → 422 op élk bericht in die sessie (7 okt 2026) |

Tests: `node proxy/test-sanitize.js` (geen dependencies, exit 1 bij falen).

Daarnaast is er een **vertaallaag** (`proxy/mistral-translate.js`, route-flag
`translate: 'mistral'`): Mistral praat alleen OpenAI-formaat
(`/v1/chat/completions`), dus Anthropic-verzoeken en -antwoorden worden
bidirectioneel omgezet — inclusief SSE-streaming (volledige Anthropic-
eventreeks + pings), tool_use/tool_result-koppeling, id-sanitizing en het
strippen van Anthropic-eigen velden (`cache_control`, `thinking`,
`output_config`) die Mistral met 422 weigert. Standaard
`reasoning_effort: "none"` (platte tekst; `high` kan via env).
Tests: `node proxy/test-mistral-translate.js`.

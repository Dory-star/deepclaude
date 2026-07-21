#!/usr/bin/env node
import { startModelProxy } from './model-proxy.js';

const BACKEND_DEFS = {
    deepseek: { url: 'https://api.deepseek.com/anthropic', keyEnv: 'DEEPSEEK_API_KEY' },
    openrouter: { url: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY' },
    fireworks: { url: 'https://api.fireworks.ai/inference/v1', keyEnv: 'FIREWORKS_API_KEY' },
    kimi: { url: 'https://api.moonshot.ai/anthropic', keyEnv: 'KIMI_API_KEY', bearer: true },
    // Local claude-code-proxy bridge (ChatGPT-subscription OAuth). Keyless:
    // the bridge does its own auth; the proxy strips inbound auth headers.
    sol: { url: 'http://127.0.0.1:18765', keyEnv: null, requiresKey: false, bearer: false },
};

function loadBackends({ includeKeyless }) {
    const backends = {};
    for (const [name, def] of Object.entries(BACKEND_DEFS)) {
        const key = def.keyEnv ? process.env[def.keyEnv] : null;
        const keyless = def.requiresKey === false;
        if (!key && !keyless && !includeKeyless) continue;
        backends[name] = {
            url: def.url,
            apiKey: key || null,
            bearer: def.bearer,
            requiresKey: def.requiresKey,
        };
    }
    return backends;
}

// Legacy mode: start-proxy.js <targetUrl> <apiKey> (used by deepclaude.sh/ps1).
// The keyless sol backend passes no key, so the gate is on targetUrl alone —
// but flag-style invocations (--mode …) must still fall through to standalone.
const targetUrl = process.argv[2] || process.env.CHEAPCLAUDE_TARGET_URL;
const apiKey = process.argv[3] || process.env.CHEAPCLAUDE_API_KEY;

// The (process.argv[2] || apiKey) guard keeps a lone CHEAPCLAUDE_TARGET_URL
// env var on the old both-vars-required semantics (standalone mode).
if (targetUrl && !targetUrl.startsWith('--') && (process.argv[2] || apiKey)) {
    // Legacy single-backend mode
    const backends = loadBackends({ includeKeyless: false });
    // Count only KEYED backends: keyless sol alone must not flip a
    // no-keys custom-target launch out of '_single' mode (that would
    // reroute the custom target's traffic to api.anthropic.com).
    const hasBackends = Object.values(backends).some(b => b.apiKey);
    // Reverse-map targetUrl to a known backend so wrapper launches boot
    // straight into that mode. Without this, a zero-key `-b sol` launch
    // degrades to '_single': backend switch 400s, remap/pricing/keyless
    // auth-strip all dead. Unknown custom targets still get '_single'.
    const bootName = Object.keys(backends).find(n => backends[n].url === targetUrl);

    const { port } = await startModelProxy({
        targetUrl,
        apiKey: apiKey || 'unused',
        backends: (hasBackends || bootName) ? backends : undefined,
        defaultMode: bootName,
    });
    console.log(port);
} else {
    // Standalone mode with live toggle
    const backends = loadBackends({ includeKeyless: true });

    const fallbackUrl = backends.deepseek?.url || 'https://api.deepseek.com/anthropic';
    const fallbackKey = backends.deepseek?.apiKey || 'unused';

    const args = process.argv.slice(2);
    const modeFlag = args.indexOf('--mode');
    const defaultMode = modeFlag >= 0 ? args[modeFlag + 1] : 'anthropic';
    const portFlag = args.indexOf('--port');
    const port = portFlag >= 0 ? parseInt(args[portFlag + 1], 10) : 3200;

    const proxy = await startModelProxy({
        targetUrl: fallbackUrl,
        apiKey: fallbackKey,
        startPort: port,
        backends,
        defaultMode,
    });

    console.log(`Proxy on :${proxy.port} (mode: ${defaultMode})`);
    console.log(`Switch: curl -sX POST http://127.0.0.1:${proxy.port}/_proxy/mode -d backend=deepseek`);
    console.log(`Status: curl -s http://127.0.0.1:${proxy.port}/_proxy/status`);
}

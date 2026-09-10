#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { startModelProxy } from './model-proxy.js';

const BACKEND_DEFS = {
    deepseek: { url: 'https://api.deepseek.com/anthropic', keyEnv: 'DEEPSEEK_API_KEY' },
    openrouter: { url: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY' },
    fireworks: { url: 'https://api.fireworks.ai/inference/v1', keyEnv: 'FIREWORKS_API_KEY' },
};

const args = process.argv.slice(2);

// Legacy mode: start-proxy.js <targetUrl> <apiKey> (used by launch_remote)
const targetUrl = args[0] || process.env.CHEAPCLAUDE_TARGET_URL;
const apiKey = args[1] || process.env.CHEAPCLAUDE_API_KEY;

// Flags (standalone mode)
const modeFlag = args.indexOf('--mode');
const mode = modeFlag >= 0 ? args[modeFlag + 1] : undefined;
const portFlag = args.indexOf('--port');
const port = portFlag >= 0 ? parseInt(args[portFlag + 1], 10) : 3200;
const dispatchFlag = args.includes('--dispatch');
const portFileFlag = args.indexOf('--port-file');
const portFile = portFileFlag >= 0 ? args[portFileFlag + 1] : null;

function loadBackends() {
    const backends = {};
    for (const [name, def] of Object.entries(BACKEND_DEFS)) {
        const key = process.env[def.keyEnv];
        if (key) backends[name] = { url: def.url, apiKey: key };
    }
    return backends;
}

if (targetUrl && apiKey && !dispatchFlag) {
    // Legacy single-backend mode: backends from env (for live toggle), target
    // from positionals. Prints the bare port on stdout (deepclaude.sh reads it).
    const backends = loadBackends();
    const hasBackends = Object.keys(backends).length > 0;

    const { port } = await startModelProxy({
        targetUrl,
        apiKey,
        backends: hasBackends ? backends : undefined,
        defaultMode: hasBackends ? undefined : undefined,
    });
    console.log(port);
} else {
    // Standalone mode — smart (dispatch) or live-toggle proxy
    const backends = {};
    for (const [name, def] of Object.entries(BACKEND_DEFS)) {
        const key = process.env[def.keyEnv];
        backends[name] = { url: def.url, apiKey: key || null };
    }

    const ds = backends.deepseek || { url: 'https://api.deepseek.com/anthropic', apiKey: 'unused' };

    let routes;
    let defaultMode = mode || 'anthropic';
    if (dispatchFlag) {
        // Per-model dispatch: deepseek-* → DeepSeek direct; z-ai/* and
        // moonshotai/* → OpenRouter. Fallback (unmatched model, non-model
        // paths) → DeepSeek, so claude-* remaps work like the ds route.
        // Prefix is 'deepseek-' (niet 'deepseek-v4-'): sinds 10 sep 2026 heet
        // het Flash-model `deepseek-flash` zonder versie in de naam. Let op:
        // OpenRouter-slugs gebruiken een slash (`deepseek/deepseek-...`) en
        // matchen hier dus bewust niet op.
        defaultMode = mode || 'deepseek';
        routes = [
            { prefix: 'deepseek-', backend: 'deepseek' },
            { prefix: 'z-ai/', backend: 'openrouter' },
            { prefix: 'moonshotai/', backend: 'openrouter' },
        ];
    }

    const proxy = await startModelProxy({
        targetUrl: ds.url,
        apiKey: ds.apiKey,
        startPort: port,
        backends,
        defaultMode,
        routes,
    });

    if (portFile) await writeFile(portFile, String(proxy.port));

    const flavor = dispatchFlag ? 'dispatch' : `mode: ${defaultMode}`;
    console.log(`Proxy on :${proxy.port} (${flavor})`);
    console.log(`Switch: curl -sX POST http://127.0.0.1:${proxy.port}/_proxy/mode -d backend=deepseek`);
    console.log(`Status: curl -s http://127.0.0.1:${proxy.port}/_proxy/status`);
}

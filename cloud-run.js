import { startModelProxy } from './proxy/model-proxy.js';

const BACKEND_DEFS = {
    deepseek:    { url: 'https://api.deepseek.com/anthropic',       keyEnv: 'DEEPSEEK_API_KEY' },
    openrouter:  { url: 'https://openrouter.ai/api/v1',             keyEnv: 'OPENROUTER_API_KEY' },
    fireworks:   { url: 'https://api.fireworks.ai/inference/v1',     keyEnv: 'FIREWORKS_API_KEY' },
    gemma:       { url: 'https://api.runpod.ai/v2/n99c4my86d90t9/openai/v1', keyEnv: 'RUNPOD_API_KEY' },
    'deepseek-rp': { url: 'https://api.runpod.ai/v2/fupn61k4juxe0v/openai/v1', keyEnv: 'RUNPOD_API_KEY' },
    kimi:        { url: 'https://api.moonshot.ai/anthropic',        keyEnv: 'KIMI_API_KEY', bearer: true },
    // sol (local claude-code-proxy bridge) is intentionally absent: a
    // 127.0.0.1 bridge is unreachable from Cloud Run.
};

const backends = {};
for (const [name, def] of Object.entries(BACKEND_DEFS)) {
    const key = process.env[def.keyEnv];
    // Thread the full def shape — dropping fields here silently reverts
    // bearer-auth backends to x-api-key (wired-but-dead 401s).
    if (key) backends[name] = { url: def.url, apiKey: key, bearer: def.bearer, requiresKey: def.requiresKey };
}

const defaultMode = process.env.DEFAULT_MODE || 'anthropic';
const port = parseInt(process.env.PORT || '8080', 10);

const fallbackUrl = backends.deepseek?.url || 'https://api.deepseek.com/anthropic';
const fallbackKey = backends.deepseek?.apiKey || 'unused';

const proxy = await startModelProxy({
    targetUrl: fallbackUrl,
    apiKey: fallbackKey,
    startPort: port,
    backends,
    defaultMode,
    bindHost: '0.0.0.0',
});

console.log(`deepclaude Cloud Run proxy on :${proxy.port} (mode: ${defaultMode})`);
console.log(`Backends: ${Object.keys(backends).join(', ')}`);

import { createServer } from 'http';
import { request as httpsRequest } from 'https';
import { URL } from 'url';
import { Transform } from 'stream';

const ANTHROPIC_FALLBACK = 'https://api.anthropic.com';
const MODEL_PATHS = ['/v1/messages'];
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per request

// Fallback-remap: alleen gebruikt als het model NIET door de dispatch-routes
// gematcht wordt (bijv. een stock `claude-*`-naam). Sinds 10 sep 2026 heet het
// Flash-model `deepseek-flash` (V4.1 Flash); de oude `deepseek-v4-flash` is
// alleen nog een legacy-alias naar hetzelfde model.
const MODEL_REMAP = {
    deepseek: {
        'claude-opus-4-6':    'deepseek-v4-pro',
        'claude-opus-4-7':    'deepseek-v4-pro',
        'claude-sonnet-4-6':  'deepseek-flash',
        'claude-sonnet-4-5-20250929': 'deepseek-flash',
        'claude-haiku-4-5-20251001':  'deepseek-flash',
    },
    openrouter: {
        'claude-opus-4-6':    'deepseek/deepseek-v4-pro',
        'claude-opus-4-7':    'deepseek/deepseek-v4-pro',
        'claude-sonnet-4-6':  'deepseek/deepseek-v4-flash',
        'claude-sonnet-4-5-20250929': 'deepseek/deepseek-v4-flash',
        'claude-haiku-4-5-20251001':  'deepseek/deepseek-v4-flash',
    },
};

// Tarieven per 1M tokens (USD), zoals door DeepSeek gefactureerd sinds
// 10 sep 2026 (V4.1 Flash, mail + api-docs.deepseek.com).
// Flits: OFF-PEAK $0.15 in / $0.60 uit; PIEK het dubbele ($0.30 / $1.20).
// Piektijden (UTC): ma-vr 01:00-04:00 en 06:00-10:00 — in NL-tijd (CEST,
// UTC+2) dus 03:00-06:00 en 08:00-12:00. Buiten die uren geldt de halve prijs.
// De tabel hieronder rekent met het off-peak tarief; de werkelijke kosten
// kunnen tijdens piekuren dus tot 2x hoger uitvallen.
const PRICING_PER_M = {
    deepseek:   { input: 0.15,  output: 0.60 },
    openrouter: { input: 0.15,  output: 0.60 },
    fireworks:  { input: 1.74,  output: 3.48 },
    anthropic:  { input: 3.00,  output: 15.00 },
    _single:    { input: 0.15,  output: 0.60 },
};

/**
 * Transform stream that intercepts SSE events and injects missing `usage`
 * fields. DeepSeek/OpenRouter may omit `usage` in message_start or
 * message_delta, which crashes Claude Code ("$.input_tokens" is undefined).
 */
class UsageNormalizer extends Transform {
    constructor(onUsage) {
        super();
        this._buf = '';
        this._onUsage = onUsage;
        this._inputTokens = 0;
        this._outputTokens = 0;
    }

    _transform(chunk, _enc, cb) {
        this._buf += chunk.toString();
        const parts = this._buf.split('\n\n');
        this._buf = parts.pop();
        for (const part of parts) {
            this.push(this._fix(part) + '\n\n');
        }
        cb();
    }

    _fix(event) {
        const m = event.match(/^data: (.+)$/m);
        if (!m) return event;
        try {
            const d = JSON.parse(m[1]);
            let changed = false;
            if (d.type === 'message_start' && d.message) {
                if (d.message.usage) {
                    this._inputTokens = d.message.usage.input_tokens || 0;
                } else {
                    d.message.usage = { input_tokens: 0, output_tokens: 0 };
                    changed = true;
                }
            }
            if (d.type === 'message_delta') {
                if (d.usage) {
                    this._outputTokens = d.usage.output_tokens || 0;
                } else {
                    d.usage = { output_tokens: 0 };
                    changed = true;
                }
            }
            if (changed) return event.replace(m[1], () => JSON.stringify(d));
        } catch { /* not JSON, pass through */ }
        return event;
    }

    _flush(cb) {
        if (this._buf.trim()) this.push(this._fix(this._buf) + '\n\n');
        if (this._onUsage) this._onUsage(this._inputTokens, this._outputTokens);
        cb();
    }
}

/**
 * For non-streaming JSON responses, ensure `usage` exists.
 */
function normalizeJsonBody(buf) {
    try {
        const obj = JSON.parse(buf);
        if (obj.type === 'message' && !obj.usage) {
            obj.usage = { input_tokens: 0, output_tokens: 0 };
            return Buffer.from(JSON.stringify(obj));
        }
    } catch { /* not JSON */ }
    return buf;
}

function stripAllThinkingBlocks(body) {
    if (!body?.messages) return;
    for (const msg of body.messages) {
        if (!Array.isArray(msg.content)) continue;
        msg.content = msg.content.filter(b => b.type !== 'thinking');
    }
}

function stripUnsignedThinkingBlocks(body) {
    if (!body?.messages) return;
    for (const msg of body.messages) {
        if (!Array.isArray(msg.content)) continue;
        msg.content = msg.content.filter(
            block => block.type !== 'thinking' || block.signature
        );
    }
}

export function startModelProxy({ targetUrl, apiKey, startPort = 3200, backends, defaultMode, routes }) {
    return new Promise((resolve, reject) => {
        const initialTarget = new URL(targetUrl);
        const initialBearer = targetUrl.includes('openrouter') || targetUrl.includes('fireworks');

        const allBackends = {};
        if (backends) {
            for (const [name, cfg] of Object.entries(backends)) {
                allBackends[name] = {
                    target: new URL(cfg.url),
                    apiKey: cfg.apiKey,
                    useBearer: cfg.url.includes('openrouter') || cfg.url.includes('fireworks'),
                };
            }
        }

        // Dispatch mode (routes): route each request by model prefix instead of
        // one session-wide backend. `backend` is a name in `backends` or an
        // inline {url, apiKey} object. Routes whose backend has no API key are
        // skipped (e.g. no OPENROUTER_API_KEY → only deepseek-v4-* dispatches).
        const dispatchRoutes = [];
        if (routes) {
            for (const r of routes) {
                // `backend` is a name in `backends` (has parsed `target`) or an
                // inline {url, apiKey} object.
                const b = typeof r.backend === 'string' ? allBackends[r.backend] : r.backend;
                if (!b?.apiKey) continue;
                const urlStr = b.target?.href || b.url;
                dispatchRoutes.push({
                    prefix: r.prefix,
                    name: typeof r.backend === 'string' ? r.backend : 'route',
                    target: new URL(urlStr),
                    apiKey: b.apiKey,
                    useBearer: /openrouter|fireworks/i.test(urlStr),
                });
            }
            // Longest prefix first so z-ai/glm-5.2 wins over a bare z-ai/ rule.
            dispatchRoutes.sort((a, b2) => b2.prefix.length - a.prefix.length);
        }
        const initialName = defaultMode || (backends ? 'anthropic' : null);
        const startBackend = initialName && initialName !== 'anthropic' && allBackends[initialName];

        const state = {
            mode: initialName || '_single',
            target: startBackend ? startBackend.target : initialTarget,
            apiKey: startBackend ? startBackend.apiKey : apiKey,
            useBearer: startBackend ? startBackend.useBearer : initialBearer,
            hadNonAnthropicSession: !!startBackend,
        };

        let reqCount = 0;
        const t0Global = Date.now();
        const costs = {};

        function recordUsage(backend, inputTokens, outputTokens) {
            if (!costs[backend]) costs[backend] = { input: 0, output: 0, requests: 0 };
            costs[backend].input += inputTokens || 0;
            costs[backend].output += outputTokens || 0;
            costs[backend].requests++;
        }

        function getCostSummary() {
            const summary = {};
            let totalActual = 0;
            let totalAnthropic = 0;
            for (const [backend, tokens] of Object.entries(costs)) {
                const p = PRICING_PER_M[backend] || PRICING_PER_M._single;
                const ap = PRICING_PER_M.anthropic;
                const actual = (tokens.input * p.input + tokens.output * p.output) / 1_000_000;
                const anthropicEq = (tokens.input * ap.input + tokens.output * ap.output) / 1_000_000;
                totalActual += actual;
                totalAnthropic += anthropicEq;
                summary[backend] = {
                    input_tokens: tokens.input,
                    output_tokens: tokens.output,
                    requests: tokens.requests,
                    cost: +actual.toFixed(4),
                    anthropic_equivalent: +anthropicEq.toFixed(4),
                };
            }
            return {
                backends: summary,
                total_cost: +totalActual.toFixed(4),
                anthropic_equivalent: +totalAnthropic.toFixed(4),
                savings: +((totalAnthropic - totalActual).toFixed(4)),
            };
        }

        function switchMode(name) {
            if (name === 'anthropic') {
                const prev = state.mode;
                state.mode = 'anthropic';
                state.target = new URL(ANTHROPIC_FALLBACK);
                state.apiKey = null;
                state.useBearer = false;
                return { mode: 'anthropic', previous: prev };
            }
            const b = allBackends[name];
            if (!b) return { error: `Unknown backend: ${name}. Valid: anthropic, ${Object.keys(allBackends).join(', ')}` };
            if (!b.apiKey) return { error: `API key not set for ${name}` };
            const prev = state.mode;
            state.mode = name;
            state.target = b.target;
            state.apiKey = b.apiKey;
            state.useBearer = b.useBearer;
            state.hadNonAnthropicSession = true;
            return { mode: name, previous: prev };
        }

        const server = createServer((clientReq, clientRes) => {
            const urlPath = clientReq.url.split('?')[0];

            // Control endpoints — /_proxy/* (never collides with /v1/*)
            if (urlPath.startsWith('/_proxy/')) {
                if (urlPath === '/_proxy/status') {
                    clientRes.writeHead(200, { 'content-type': 'application/json' });
                    clientRes.end(JSON.stringify({
                        mode: state.mode,
                        uptime: Math.round((Date.now() - t0Global) / 1000),
                        requests: reqCount,
                    }));
                    return;
                }
                if (urlPath === '/_proxy/cost') {
                    clientRes.writeHead(200, { 'content-type': 'application/json' });
                    clientRes.end(JSON.stringify(getCostSummary()));
                    return;
                }
                if (urlPath === '/_proxy/mode' && clientReq.method === 'POST') {
                    const origin = clientReq.headers['origin'] || '';
                    if (origin && !origin.startsWith('http://127.0.0.1') && !origin.startsWith('http://localhost')) {
                        clientRes.writeHead(403, { 'content-type': 'application/json' });
                        clientRes.end(JSON.stringify({ error: 'Forbidden' }));
                        return;
                    }
                    const chunks = [];
                    let bodySize = 0;
                    clientReq.on('data', c => {
                        bodySize += c.length;
                        if (bodySize > 1024) { clientReq.destroy(); return; }
                        chunks.push(c);
                    });
                    clientReq.on('end', () => {
                        const body = Buffer.concat(chunks).toString();
                        const m = body.match(/backend=([a-z]+)/);
                        if (!m) {
                            clientRes.writeHead(400, { 'content-type': 'application/json' });
                            clientRes.end(JSON.stringify({ error: 'Missing backend= in body' }));
                            return;
                        }
                        const result = switchMode(m[1]);
                        if (result.error) {
                            clientRes.writeHead(400, { 'content-type': 'application/json' });
                            clientRes.end(JSON.stringify(result));
                            return;
                        }
                        console.log(`[MODEL-PROXY] Mode switched: ${result.previous} → ${result.mode}`);
                        clientRes.writeHead(200, { 'content-type': 'application/json' });
                        clientRes.end(JSON.stringify(result));
                    });
                    return;
                }
                if (urlPath === '/_proxy/mode' && clientReq.method !== 'POST') {
                    clientRes.writeHead(405, { 'content-type': 'application/json' });
                    clientRes.end(JSON.stringify({ error: 'Use POST' }));
                    return;
                }
                clientRes.writeHead(404, { 'content-type': 'application/json' });
                clientRes.end(JSON.stringify({ error: 'Not found' }));
                return;
            }

            // In anthropic mode, everything passes through transparently
            const isAnthropicMode = state.mode === 'anthropic';
            const isModelCall = !isAnthropicMode && MODEL_PATHS.includes(urlPath);
            const dispatchEnabled = isModelCall && dispatchRoutes.length > 0;

            const chunks = [];
            clientReq.on('data', c => chunks.push(c));
            clientReq.on('end', () => {
                let body = Buffer.concat(chunks);

                // Pick the upstream for this request.
                // Dispatch mode (smart proxy): choose per model name from the
                // request body — deepseek-v4-* → DeepSeek, z-ai/* & moonshotai/*
                // → OpenRouter — so one Claude Code session can hop between
                // providers via /model. Anything the routes don't match falls
                // back to the session target (deepseek), like a plain ds session.
                let dest, reqKey, reqBearer, backendName, remapModel;
                let parsed = null;
                try { parsed = JSON.parse(body); } catch { /* not JSON */ }

                // Claude Code appends "[1m]" (and similar) to model names of
                // unknown big-context models; backends only know the bare name,
                // so strip the suffix and send the cleaned name upstream.
                if (parsed && typeof parsed.model === 'string' && /\[1m\]$/.test(parsed.model)) {
                    parsed.model = parsed.model.replace(/\[1m\]$/, '');
                    body = Buffer.from(JSON.stringify(parsed));
                }

                if (dispatchEnabled) {
                    const model = parsed?.model || '';
                    const route = dispatchRoutes.find(r => model.startsWith(r.prefix));
                    if (route) {
                        dest = route.target;
                        reqKey = route.apiKey;
                        reqBearer = route.useBearer;
                        backendName = route.name;
                    } else {
                        dest = state.target;
                        reqKey = state.apiKey;
                        reqBearer = state.useBearer;
                        backendName = state.mode;
                        // Unmatched name (e.g. a stock claude-*): remap it to
                        // this backend's model, as the ds route would.
                        remapModel = MODEL_REMAP[state.mode];
                    }
                } else {
                    dest = isModelCall ? state.target : new URL(ANTHROPIC_FALLBACK);
                    reqKey = state.apiKey;
                    reqBearer = state.useBearer;
                    backendName = state.mode;
                    remapModel = isModelCall ? MODEL_REMAP[state.mode] : null;
                }

                // Build upstream path. dest.pathname may overlap with
                // clientReq.url (e.g. OpenRouter /api/v1 + /v1/messages).
                // Strip the shared prefix to avoid /api/v1/v1/messages.
                let fullPath;
                if (isModelCall) {
                    const base = dest.pathname.replace(/\/$/, '');
                    let overlap = '';
                    for (let i = 1; i <= Math.min(base.length, urlPath.length); i++) {
                        if (base.endsWith(urlPath.substring(0, i))) overlap = urlPath.substring(0, i);
                    }
                    fullPath = overlap ? base + urlPath.substring(overlap.length) : base + urlPath;
                } else {
                    fullPath = clientReq.url;
                }

                const reqId = ++reqCount;
                const t0 = Date.now();

                if (isModelCall) {
                    const tag = dispatchEnabled ? `dispatch:${backendName}` : backendName;
                    console.log(`[MODEL-PROXY] #${reqId} (${tag}, model=${parsed?.model || '?'}) → ${dest.hostname}${fullPath}`);
                }

                const headers = { ...clientReq.headers, host: dest.host };
                delete headers['content-length'];

                if (isModelCall) {
                    delete headers['authorization'];
                    delete headers['x-api-key'];
                    if (reqBearer) {
                        headers['authorization'] = `Bearer ${reqKey}`;
                    } else {
                        headers['x-api-key'] = reqKey;
                    }
                }

                // Remap Anthropic model names to backend-specific names
                if (isModelCall && remapModel) {
                    try {
                        const mapped = remapModel[parsed?.model];
                        if (mapped) {
                            console.log(`[MODEL-PROXY] #${reqId} model remap: ${parsed.model} → ${mapped}`);
                            parsed.model = mapped;
                            body = Buffer.from(JSON.stringify(parsed));
                        }
                    } catch { /* not JSON or parse error, pass through */ }
                }

                // Strip thinking blocks before forwarding.
                // Non-Anthropic: strip ALL blocks — backends reject thinking blocks
                // they didn't generate, even unsigned ones.
                // Anthropic after a non-Anthropic session: also strip ALL, because
                // foreign backends generate signed-but-invalid thinking blocks that
                // stripUnsignedThinkingBlocks passes through, causing Anthropic 400s.
                if (isAnthropicMode && MODEL_PATHS.includes(urlPath)) {
                    try {
                        const p = JSON.parse(body);
                        if (state.hadNonAnthropicSession) {
                            stripAllThinkingBlocks(p);
                        } else {
                            stripUnsignedThinkingBlocks(p);
                        }
                        body = Buffer.from(JSON.stringify(p));
                    } catch { /* pass through */ }
                }
                if (isModelCall) {
                    try {
                        const p = JSON.parse(body);
                        stripAllThinkingBlocks(p);
                        body = Buffer.from(JSON.stringify(p));
                    } catch { /* pass through */ }
                }

                const opts = {
                    hostname: dest.hostname,
                    port: dest.port || 443,
                    path: fullPath,
                    method: clientReq.method,
                    headers: { ...headers, 'content-length': body.length },
                    timeout: REQUEST_TIMEOUT_MS,
                };

                const proxyReq = httpsRequest(opts, (proxyRes) => {
                    if (isModelCall) {
                        const ttfb = Date.now() - t0;
                        console.log(`[MODEL-PROXY] #${reqId} TTFB ${ttfb}ms (status ${proxyRes.statusCode})`);
                    }

                    const ct = proxyRes.headers['content-type'] || '';
                    const isSSE = ct.includes('text/event-stream');

                    if (isModelCall && isSSE) {
                        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
                        const norm = new UsageNormalizer((inp, out) => recordUsage(backendName, inp, out));
                        proxyRes.pipe(norm).pipe(clientRes);
                        proxyRes.on('end', () => {
                            console.log(`[MODEL-PROXY] #${reqId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s (${norm._inputTokens}in/${norm._outputTokens}out)`);
                        });
                    } else if (isModelCall && ct.includes('application/json')) {
                        const respChunks = [];
                        proxyRes.on('data', c => respChunks.push(c));
                        proxyRes.on('end', () => {
                            const raw = Buffer.concat(respChunks);
                            const fixed = normalizeJsonBody(raw);
                            try {
                                const j = JSON.parse(fixed);
                                if (j.usage) recordUsage(backendName, j.usage.input_tokens, j.usage.output_tokens);
                            } catch {}
                            const outHeaders = { ...proxyRes.headers, 'content-length': fixed.length };
                            clientRes.writeHead(proxyRes.statusCode, outHeaders);
                            clientRes.end(fixed);
                            console.log(`[MODEL-PROXY] #${reqId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s (json, ${fixed.length}b)`);
                        });
                    } else {
                        // Non-model or unknown content-type: pass through
                        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
                        proxyRes.pipe(clientRes);
                        if (isModelCall) {
                            proxyRes.on('end', () => {
                                console.log(`[MODEL-PROXY] #${reqId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
                            });
                        }
                    }
                });

                proxyReq.on('timeout', () => {
                    console.error(`[MODEL-PROXY] #${reqId} TIMEOUT after ${REQUEST_TIMEOUT_MS / 1000}s`);
                    proxyReq.destroy(new Error('Request timeout'));
                });

                proxyReq.on('error', (err) => {
                    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                    console.error(`[MODEL-PROXY] #${reqId} ERROR after ${elapsed}s: ${err.message}`);
                    if (!clientRes.headersSent) {
                        clientRes.writeHead(502, { 'content-type': 'application/json' });
                    }
                    clientRes.end(JSON.stringify({ error: { message: 'Upstream connection error' } }));
                });

                proxyReq.end(body);
            });
        });

        function tryListen(port) {
            server.once('error', (err) => {
                if (err.code === 'EADDRINUSE' && port < startPort + 20) {
                    tryListen(port + 1);
                } else {
                    reject(err);
                }
            });
            server.listen(port, '127.0.0.1', () => {
                const actualPort = server.address().port;
                console.log(`[MODEL-PROXY] Listening on 127.0.0.1:${actualPort} → ${targetUrl} (mode: ${state.mode})`);
                resolve({ port: actualPort, close: () => server.close(), switchMode });
            });
        }

        tryListen(startPort);
    });
}

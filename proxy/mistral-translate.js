/**
 * Vertaallaag Anthropic Messages API ⇄ Mistral (OpenAI Chat Completions).
 *
 * Waarom deze laag bestaat: DeepSeek en OpenRouter accepteren Anthropic-formaat,
 * Mistral niet — die praat alleen OpenAI-formaat (/v1/chat/completions). Claude
 * Code spreekt Anthropic (incl. SSE-streaming en tool_use/tool_result-blokken),
 * dus alles moet hier heen en terug vertaald worden.
 *
 * Ontwerpkeuzes (gebaseerd op onderzoek 7 okt 2026 + eigen probes):
 *  - `reasoning_effort: "none"` als standaard: bewezen dat Mistral Large 4 dan
 *    platte-tekst-content teruggeeft (geen denk-blokken-array), tools en
 *    streaming gewoon werken. Dat vermijdt de hele klasse problemen rond
 *    Anthropic thinking-blokken (signature-verplichting e.d.).
 *    Content-in-array-vorm wordt defensief alsnog geparseerd.
 *  - Nooit `cache_control`/`thinking`/`output_config` e.d. naar Mistral: die
 *    geven daar 422's ("extra_forbidden").
 *  - Nooit eerder ontvangen reasoning terugsturen in de geschiedenis: idem 422
 *    zodra er tool-calls in het spel zijn.
 *  - Tool-ids: sanitizen naar [a-zA-Z0-9_-] en uniek maken (Anthropic-eis).
 *  - Streaming: volledige Anthropic-eventreeks uitsturen (message_start →
 *    content_block_start/delta/stop → message_delta met stop_reason + usage →
 *    message_stop) plus periodieke ping-events tegen de idle-watchdog van
 *    Claude Code.
 */

const ID_SAFE = /[^a-zA-Z0-9_-]/g;

/** Anthropic-vereiste: ^[a-zA-Z0-9_-]+$ ; leeg/onveilig → deterministische fallback. */
export function sanitizeToolId(id, fallback) {
    if (typeof id === 'string' && id.length > 0) {
        const s = id.replace(ID_SAFE, '_');
        if (s.length > 0) return s;
    }
    return fallback || `toolu_${Date.now().toString(36)}`;
}

function deepStripCacheControl(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 40) return node;
    if (Array.isArray(node)) { node.forEach(n => deepStripCacheControl(n, depth + 1)); return node; }
    delete node.cache_control;
    for (const v of Object.values(node)) deepStripCacheControl(v, depth + 1);
    return node;
}

/** Mistral-content kan string óf chunk-array zijn (thinking + text). Pak alleen tekst. */
export function messageTextOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const c of content) {
        if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
        // thinking-chunks bewust overslaan (reasoning_effort=none levert ze niet;
        // mochten ze toch komen, dan zijn ze voor Claude Code niet reconstrueerbaar).
    }
    return parts.join('');
}

/** tool_result.content (string | blokken-array | leeg) → niet-lege string voor role:"tool". */
export function toolResultToText(tr) {
    const c = tr?.content;
    if (typeof c === 'string' && c.length > 0) return c;
    const parts = [];
    if (Array.isArray(c)) {
        for (const b of c) {
            if (!b) continue;
            if (b.type === 'text' && typeof b.text === 'string' && b.text.length) parts.push(b.text);
            else if (b.type === 'tool_reference') parts.push(`[Loaded tool: ${b.tool_name || 'unknown'}]`);
            else if (b.type === 'image') parts.push('[image omitted: not supported in tool results]');
            else if (typeof b === 'object') parts.push(JSON.stringify(b));
        }
    }
    const joined = parts.join('\n');
    return joined.length > 0 ? joined : '[empty tool result]';
}

function imageSourceToUrl(src) {
    if (!src || typeof src !== 'object') return null;
    if (src.type === 'base64' && src.data) return `data:${src.media_type || 'image/png'};base64,${src.data}`;
    if (src.type === 'url' && src.url) return src.url;
    return null; // type "file" heeft geen OpenAI-equivalent
}

function safeParseJson(s) {
    if (typeof s !== 'string' || s.length === 0) return {};
    try { const v = JSON.parse(s); return (v && typeof v === 'object') ? v : {}; }
    catch { return {}; }
}

/**
 * Anthropic Messages-verzoek → Mistral chat/completions-body.
 * We bouwen de body vanaf nul op: alles wat Anthropic-eigen is (thinking,
 * output_config, cache_control, metadata, top_k …) valt daarmee automatisch af.
 */
export function toMistralRequest(anthropic, opts = {}) {
    const reasoningEffort = opts.reasoningEffort || 'none';
    const out = {
        model: opts.model || anthropic.model,
        stream: !!anthropic.stream,
        max_tokens: anthropic.max_tokens != null ? anthropic.max_tokens : 8192,
    };
    if (anthropic.temperature != null) out.temperature = anthropic.temperature;
    if (anthropic.top_p != null) out.top_p = anthropic.top_p;
    if (Array.isArray(anthropic.stop_sequences) && anthropic.stop_sequences.length) {
        out.stop = anthropic.stop_sequences;
    }

    const systemText = [];
    const sys = anthropic.system;
    if (typeof sys === 'string') systemText.push(sys);
    else if (Array.isArray(sys)) {
        for (const b of sys) {
            if (b?.type === 'text' && typeof b.text === 'string') systemText.push(b.text);
            else if (b) systemText.push(JSON.stringify(b));
        }
    }

    const messages = [];
    for (const msg of anthropic.messages || []) {
        const role = msg?.role;
        const content = msg?.content;

        if (typeof content === 'string') {
            if (role === 'system') { systemText.push(content); continue; }
            if (content.length === 0) continue;
            messages.push({ role: role === 'assistant' ? 'assistant' : 'user', content });
            continue;
        }
        if (!Array.isArray(content)) continue;

        if (role === 'system') {
            // Mid-conversation system-bericht (Claude Code gebruikt die o.a. voor
            // tool-addition). Tekst hoisten we naar het system-bericht; de
            // tool_addition/tool_removal-blokken laten we vallen — de tools staan
            // al in `tools[]`, en Mistral kent die blokvorm niet.
            for (const b of content) {
                if (b?.type === 'text' && typeof b.text === 'string' && b.text.length) systemText.push(b.text);
            }
            continue;
        }

        if (role === 'assistant') {
            const textParts = [];
            const toolCalls = [];
            for (const b of content) {
                if (b?.type === 'text' && typeof b.text === 'string' && b.text.length) textParts.push(b.text);
                else if (b?.type === 'tool_use') {
                    toolCalls.push({
                        id: sanitizeToolId(b.id, `toolu_${toolCalls.length}`),
                        type: 'function',
                        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
                    });
                }
                // thinking-blokken: bewust laten vallen (vreemde reasoning in de
                // geschiedenis → 422 bij Mistral zodra er tool-calls spelen).
            }
            const text = textParts.join('\n');
            if (text.length === 0 && toolCalls.length === 0) continue;
            const m = { role: 'assistant', content: text.length > 0 ? text : null };
            if (toolCalls.length > 0) m.tool_calls = toolCalls;
            messages.push(m);
            continue;
        }

        // user
        const toolResults = [];
        const parts = [];
        for (const b of content) {
            if (b?.type === 'tool_result') toolResults.push(b);
            else if (b?.type === 'text' && typeof b.text === 'string' && b.text.length) parts.push({ type: 'text', text: b.text });
            else if (b?.type === 'image') {
                const url = imageSourceToUrl(b.source);
                if (url) parts.push({ type: 'image_url', image_url: { url } });
            }
        }
        // OpenAI-eis: role:"tool"-berichten direct ná de bijbehorende assistant
        // tool_calls. In Anthropic staat het tool_result-blok vooraan in de
        // user-message, dus deze volgorde klopt.
        for (const tr of toolResults) {
            messages.push({
                role: 'tool',
                tool_call_id: sanitizeToolId(tr.tool_use_id, 'toolu_missing'),
                content: toolResultToText(tr),
            });
        }
        if (parts.length > 0) {
            const onlyText = parts.length === 1 && parts[0].type === 'text';
            messages.push({ role: 'user', content: onlyText ? parts[0].text : parts });
        }
    }

    if (systemText.length > 0) messages.unshift({ role: 'system', content: systemText.join('\n\n') });
    out.messages = messages;

    // Tools: Anthropic input_schema → OpenAI function.parameters.
    // Server-tools (web_search e.d.) hebben een type en horen hier niet.
    if (Array.isArray(anthropic.tools) && anthropic.tools.length > 0) {
        const tools = [];
        for (const t of anthropic.tools) {
            if (!t?.name || !t?.input_schema) continue;
            if (t.type && t.type !== 'custom') continue;
            const params = deepStripCacheControl(JSON.parse(JSON.stringify(t.input_schema)));
            delete params.$schema;
            tools.push({
                type: 'function',
                function: { name: t.name, description: t.description || '', parameters: params },
            });
        }
        if (tools.length > 0) out.tools = tools;
    }

    const tc = anthropic.tool_choice;
    if (tc && typeof tc === 'object') {
        if (tc.type === 'auto') out.tool_choice = 'auto';
        else if (tc.type === 'any') out.tool_choice = 'required';
        else if (tc.type === 'none') out.tool_choice = 'none';
        else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
        if (tc.disable_parallel_tool_use === true) out.parallel_tool_calls = false;
    }

    if (reasoningEffort && reasoningEffort !== 'off') out.reasoning_effort = reasoningEffort;
    return out;
}

const STOP_REASON_MAP = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens', content_filter: 'end_turn' };

export function mapStopReason(finishReason, hadToolBlocks) {
    if (hadToolBlocks) return 'tool_use';
    return STOP_REASON_MAP[finishReason] || 'end_turn';
}

function usageFromMistral(u) {
    return {
        input_tokens: u?.prompt_tokens || 0,
        output_tokens: u?.completion_tokens || 0,
        cache_read_input_tokens: u?.prompt_tokens_details?.cached_tokens || 0,
        cache_creation_input_tokens: 0,
    };
}

let msgCounter = 0;

/** Mistral chat-completion-JSON → Anthropic message-object (non-streaming). */
export function fromMistralResponse(json, model) {
    const choice = json?.choices?.[0] || {};
    const m = choice.message || {};
    const content = [];
    const text = messageTextOf(m.content);
    if (text.length > 0) content.push({ type: 'text', text });
    const seen = new Set();
    for (const tc of m.tool_calls || []) {
        let id = sanitizeToolId(tc?.id, `toolu_${msgCounter}`);
        while (seen.has(id)) id = `${id}_${seen.size}`;
        seen.add(id);
        content.push({ type: 'tool_use', id, name: tc?.function?.name || 'unknown', input: safeParseJson(tc?.function?.arguments) });
    }
    const hadTools = (m.tool_calls || []).length > 0;
    return {
        id: `msg_${json?.id || `${Date.now().toString(36)}_${++msgCounter}`}`,
        type: 'message',
        role: 'assistant',
        model: model || json?.model || 'mistral-large-4',
        content,
        stop_reason: mapStopReason(choice.finish_reason, hadTools),
        stop_sequence: null,
        usage: usageFromMistral(json?.usage),
    };
}

/**
 * Streaming-vertaler: OpenAI/Mistral SSE-chunks → Anthropic SSE-events.
 * Bewust géén stream-Transform: een simpel feed/end-object, zodat de tests
 * synchroon kunnen draaien. De proxy wikkelt er een Transform omheen.
 *
 * Event-reeks (Claude Code-eis): message_start → per blok
 * content_block_start, daarna deltas, dan content_block_stop → message_delta
 * (stop_reason + usage) → message_stop. Pings bij stilte tegen de watchdog.
 */
export function createMistralStreamTranslator({ model, onUsage, pingMs = 15000 } = {}) {
    let sink = () => {};
    let buf = '';
    let started = false;
    let nextIndex = 0;
    let openBlock = null;              // {index, type}
    const toolByOpenAiIndex = new Map(); // openai tool index → {index, id, name, buf, hadArgs}
    let stopReason = null;
    let usage = null;
    let messageId = null;
    const seenIds = new Set();
    let finished = false;
    let pingTimer = null;
    let lastEmit = Date.now();

    function emit(event, data) {
        lastEmit = Date.now();
        sink(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    if (pingMs > 0) {
        pingTimer = setInterval(() => {
            if (finished) return;
            if (Date.now() - lastEmit >= pingMs) emit('ping', { type: 'ping' });
        }, pingMs);
        if (pingTimer.unref) pingTimer.unref();
    }

    function ensureStarted() {
        if (started) return;
        started = true;
        emit('message_start', {
            type: 'message_start',
            message: {
                id: `msg_${messageId || `${Date.now().toString(36)}_${++msgCounter}`}`,
                type: 'message',
                role: 'assistant',
                model: model || 'mistral-large-4',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: usage?.prompt_tokens || 0, output_tokens: 0 },
            },
        });
    }

    function closeOpen() {
        if (!openBlock) return;
        emit('content_block_stop', { type: 'content_block_stop', index: openBlock.index });

        openBlock = null;
    }

    function ensureTextBlock() {
        if (openBlock?.type === 'text') return openBlock.index;
        closeOpen();
        ensureStarted();
        const index = nextIndex++;
        emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        openBlock = { index, type: 'text' };
        return index;
    }

    function toolBlockFor(tc) {
        const idx = tc?.index ?? 0;
        let block = toolByOpenAiIndex.get(idx);
        if (block) return block;
        closeOpen();
        ensureStarted();
        let id = sanitizeToolId(tc?.id, `toolu_${Date.now().toString(36)}_${idx}`);
        while (seenIds.has(id)) id = `${id}_${seenIds.size}`;
        seenIds.add(id);
        const index = nextIndex++;
        block = { index, id, name: tc?.function?.name || '', buf: '' };
        toolByOpenAiIndex.set(idx, block);
        emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: block.name, input: {} } });
        openBlock = { index, type: 'tool_use' };
        return block;
    }

    function handleDelta(delta) {
        if (!delta) return;
        // content: string (normaal met reasoning_effort=none) of chunk-array (defensief)
        if (typeof delta.content === 'string') {
            if (delta.content.length > 0) {
                const index = ensureTextBlock();
                emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta.content } });
            }
        } else if (Array.isArray(delta.content)) {
            const text = messageTextOf(delta.content);
            if (text.length > 0) {
                const index = ensureTextBlock();
                emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
            }
        }
        for (const tc of delta.tool_calls || []) {
            const block = toolBlockFor(tc);
            if (typeof tc?.function?.arguments === 'string' && tc.function.arguments.length > 0) {
                block.buf += tc.function.arguments;
                emit('content_block_delta', { type: 'content_block_delta', index: block.index, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
            }
        }
    }

    function finalize() {
        if (finished) return;
        finished = true;
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        ensureStarted();       // lege stream → alsnog een complete reeks
        closeOpen();
        const hadTools = toolByOpenAiIndex.size > 0;
        emit('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason || mapStopReason(null, hadTools), stop_sequence: null },
            usage: { output_tokens: usage?.completion_tokens || 0, input_tokens: usage?.prompt_tokens || 0 },
        });
        emit('message_stop', { type: 'message_stop' });
        if (onUsage) onUsage(usage?.prompt_tokens || 0, usage?.completion_tokens || 0);
    }

    return {
        setSink(fn) { sink = fn; },
        /** OpenAI/Mistral SSE-tekst (mogelijk deel van een chunk) erin stoppen. */
        feed(str) {
            if (finished) return;
            buf += str;
            const lines = buf.split('\n');
            buf = lines.pop();               // onvolledige laatste regel bewaren
            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data:')) continue;
                const payload = t.slice(5).trim();
                if (payload === '[DONE]') { finalize(); return; }
                let j;
                try { j = JSON.parse(payload); } catch { continue; }
                if (j?.error || j?.object === 'error') {
                    emit('error', { type: 'error', error: { type: 'api_error', message: j.error?.message || 'Upstream error' } });
                    finalize();
                    return;
                }
                if (j?.id) messageId = j.id;
                if (j?.usage) usage = j.usage;
                const choice = j?.choices?.[0];
                if (!choice) continue;
                handleDelta(choice.delta);
                if (choice.finish_reason) stopReason = mapStopReason(choice.finish_reason, toolByOpenAiIndex.size > 0);
            }
        },
        end() { finalize(); },
        /** Voor tests: alle tot nu toe verzonden events als string. */
        _debug: { toolBlockCount: () => toolByOpenAiIndex.size },
    };
}

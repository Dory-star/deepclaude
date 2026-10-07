#!/usr/bin/env node
/**
 * Unit tests voor de Mistral-vertaallaag (mistral-translate.js).
 * Draaien: node proxy/test-mistral-translate.js   (geen dependencies, exit 1 bij falen)
 * Fixtures zijn afgeleid van echte Mistral Large 4-antwoorden (probes 7 okt 2026).
 */
import { strict as assert } from 'node:assert';
import {
    toMistralRequest, fromMistralResponse, createMistralStreamTranslator, sanitizeToolId,
} from './mistral-translate.js';

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ok   ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n       ${err.message.split('\n')[0]}`); }
}

function parseEvents(s) {
    return s.split('\n\n').filter(Boolean).map(part => {
        const m = part.match(/^event: (.+)\ndata: (.+)$/s);
        return { event: m[1], data: JSON.parse(m[2]) };
    });
}

console.log('toMistralRequest');

test('basis: tekst, stream, max_tokens, reasoning_effort=none', () => {
    const out = toMistralRequest({
        model: 'mistral-large-4', max_tokens: 100, stream: true,
        messages: [{ role: 'user', content: 'hoi' }],
    });
    assert.equal(out.model, 'mistral-large-4');
    assert.equal(out.stream, true);
    assert.equal(out.max_tokens, 100);
    assert.equal(out.reasoning_effort, 'none');
    assert.deepEqual(out.messages, [{ role: 'user', content: 'hoi' }]);
});

test('system-array wordt platgeslagen; cache_control verdwijnt overal', () => {
    const out = toMistralRequest({
        max_tokens: 10,
        system: [{ type: 'text', text: 'A', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'B' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }],
    });
    assert.equal(out.messages[0].role, 'system');
    assert.equal(out.messages[0].content, 'A\n\nB');
    assert.equal(out.messages[1].content, 'x');
    assert.ok(!JSON.stringify(out).includes('cache_control'));
});

test('mid-conversation system: tekst gehoist, tool_addition gedropt', () => {
    const out = toMistralRequest({
        max_tokens: 10,
        messages: [
            { role: 'user', content: 'vraag' },
            { role: 'system', content: [
                { type: 'text', text: 'noot' },
                { type: 'tool_addition', tool: { type: 'tool_definition', definition: { name: 'x' } } },
            ] },
        ],
    });
    assert.equal(out.messages[0].content, 'noot');
    assert.equal(out.messages[1].content, 'vraag');
    assert.ok(!JSON.stringify(out).includes('tool_addition'));
});

test('assistant tool_use → tool_calls; user tool_result → role:"tool"', () => {
    const out = toMistralRequest({
        max_tokens: 10,
        messages: [
            { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'weer', input: { city: "A'dam" } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'zonnig' }] },
        ],
    });
    const a = out.messages[0];
    assert.equal(a.tool_calls[0].id, 'toolu_01');
    assert.equal(a.tool_calls[0].function.name, 'weer');
    assert.deepEqual(JSON.parse(a.tool_calls[0].function.arguments), { city: "A'dam" });
    const t = out.messages[1];
    assert.deepEqual(t, { role: 'tool', tool_call_id: 'toolu_01', content: 'zonnig' });
});

test('tool_result met blokken-array/leeg → niet-lege string', () => {
    const out = toMistralRequest({
        max_tokens: 10,
        messages: [{ role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'deel1' }, { type: 'tool_reference', tool_name: 'X' }] },
            { type: 'tool_result', tool_use_id: 'b', content: [] },
        ] }],
    });
    assert.equal(out.messages[0].content, 'deel1\n[Loaded tool: X]');
    assert.equal(out.messages[1].content, '[empty tool result]');
});

test('tools: input_schema → parameters, $schema weg, server-tool overgeslagen', () => {
    const out = toMistralRequest({
        max_tokens: 10, messages: [{ role: 'user', content: 'x' }],
        tools: [
            { name: 'lees', description: 'd', input_schema: { $schema: 'http://x', type: 'object', properties: { p: { type: 'string', cache_control: { type: 'ephemeral' } } } } },
            { name: 'web_search', type: 'web_search_20250305', input_schema: { type: 'object' } },
        ],
    });
    assert.equal(out.tools.length, 1);
    assert.equal(out.tools[0].function.name, 'lees');
    assert.equal(out.tools[0].function.parameters.$schema, undefined);
    assert.equal(out.tools[0].function.parameters.properties.p.cache_control, undefined);
});

test('tool_choice-mapping + disable_parallel_tool_use', () => {
    const mk = (tc) => toMistralRequest({ max_tokens: 5, messages: [], tool_choice: tc }).tool_choice;
    assert.equal(mk({ type: 'auto' }), 'auto');
    assert.equal(mk({ type: 'any' }), 'required');
    assert.equal(mk({ type: 'none' }), 'none');
    assert.deepEqual(mk({ type: 'tool', name: 'x' }), { type: 'function', function: { name: 'x' } });
    const par = toMistralRequest({ max_tokens: 5, messages: [], tool_choice: { type: 'auto', disable_parallel_tool_use: true } });
    assert.equal(par.parallel_tool_calls, false);
});

test('thinking-historie en Anthropic-eigen velden lekken niet door', () => {
    const out = toMistralRequest({
        max_tokens: 10, thinking: { type: 'adaptive' }, output_config: { effort: 'max' },
        context_management: { x: 1 }, metadata: { user_id: 'u' }, top_k: 40,
        messages: [
            { role: 'assistant', content: [{ type: 'thinking', thinking: 'stil', signature: 'sig' }, { type: 'text', text: 'antwoord' }] },
            { role: 'user', content: 'verder' },
        ],
    });
    const s = JSON.stringify(out);
    assert.ok(!s.includes('thinking') && !s.includes('output_config') && !s.includes('context_management'));
    assert.ok(!s.includes('metadata') && !s.includes('top_k') && !s.includes('signature'));
    assert.equal(out.messages[0].content, 'antwoord');
});

console.log('fromMistralResponse');

test('tekst + usage-mapping (incl. cached tokens)', () => {
    const r = fromMistralResponse({
        id: 'abc', model: 'mistral-large-4',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } },
    });
    assert.equal(r.type, 'message');
    assert.equal(r.content[0].text, 'ok');
    assert.equal(r.stop_reason, 'end_turn');
    assert.deepEqual(r.usage, { input_tokens: 11, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 });
});

test('tool_calls: args parsen, kapotte JSON → {}, id sanitizen, stop_reason tool_use', () => {
    const r = fromMistralResponse({
        choices: [{ message: { content: null, tool_calls: [
            { id: 'D681PevKs!', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
            { id: 'twee', type: 'function', function: { name: 'b', arguments: '{kapot' } },
        ] }, finish_reason: 'tool_calls' }],
    });
    assert.equal(r.content[0].id, 'D681PevKs_');
    assert.deepEqual(r.content[0].input, { x: 1 });
    assert.deepEqual(r.content[1].input, {});
    assert.equal(r.stop_reason, 'tool_use');
});

test('finish_reason-mapping: length→max_tokens, onbekend→end_turn', () => {
    const mk = (fr) => fromMistralResponse({ choices: [{ message: { content: 'x' }, finish_reason: fr }] }).stop_reason;
    assert.equal(mk('length'), 'max_tokens');
    assert.equal(mk('wat_dan_ook'), 'end_turn');
});

console.log('createMistralStreamTranslator');

function runStream(chunks, opts = {}) {
    const t = createMistralStreamTranslator({ model: 'mistral-large-4', pingMs: 0, ...opts });
    let out = '';
    t.setSink(s => { out += s; });
    for (const c of chunks) t.feed(c);
    t.end();
    return { out, events: parseEvents(out), t };
}

test('tekst-stream: complete Anthropic-reeks met stop_reason en usage', () => {
    const { events } = runStream([
        'data: {"id":"m1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
        'data: {"id":"m1","choices":[{"index":0,"delta":{"content":"Ik"},"finish_reason":null}]}\n\n',
        'data: {"id":"m1","choices":[{"index":0,"delta":{"content":" tel"},"finish_reason":null}]}\n\n',
        'data: {"id":"m1","choices":[{"index":0,"delta":{"content":" drie"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
        'data: [DONE]\n\n',
    ]);
    const kinds = events.map(e => e.event);
    assert.deepEqual(kinds, [
        'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_delta',
        'content_block_stop', 'message_delta', 'message_stop',
    ]);
    assert.equal(events[0].data.message.id, 'msg_m1');
    assert.equal(events[1].data.content_block.type, 'text');
    assert.equal(events[2].data.delta.text + events[3].data.delta.text + events[4].data.delta.text, 'Ik tel drie');
    assert.equal(events[6].data.delta.stop_reason, 'end_turn');
    assert.equal(events[6].data.usage.output_tokens, 3);
});

test('tool-call met gesplitste JSON-fragmenten; usage-callback', () => {
    let usageCb = null;
    const { events } = runStream([
        'data: {"id":"m2","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
        'data: {"id":"m2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"abc123","type":"function","function":{"name":"weer","arguments":""}}]}}]}\n\n',
        'data: {"id":"m2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}\n\n',
        'data: {"id":"m2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"A\\"}"}}]}}]}\n\n',
        'data: {"id":"m2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":9}}\n\n',
        'data: [DONE]\n\n',
    ], { onUsage: (i, o) => { usageCb = [i, o]; } });
    const start = events.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use');
    assert.equal(start.data.content_block.id, 'abc123');
    assert.equal(start.data.content_block.name, 'weer');
    const deltas = events.filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta');
    const json = deltas.map(d => d.data.delta.partial_json).join('');
    assert.deepEqual(JSON.parse(json), { city: 'A' });
    const stop = events.find(e => e.event === 'message_delta');
    assert.equal(stop.data.delta.stop_reason, 'tool_use');
    assert.deepEqual(usageCb, [20, 9]);
});

test('parallelle tool-calls met eigen indices; elke delta heeft een geopend blok', () => {
    const { events } = runStream([
        'data: {"id":"m3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a1","function":{"name":"x","arguments":"{\\"q\\":1}"}}]}}]}\n\n',
        'data: {"id":"m3","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"b2","function":{"name":"y","arguments":"{\\"q\\":2}"}}]}}]}\n\n',
        'data: {"id":"m3","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
    ]);
    const starts = events.filter(e => e.event === 'content_block_start').map(e => e.data.content_block.name);
    assert.deepEqual(starts, ['x', 'y']);
    const opened = new Set(events.filter(e => e.event === 'content_block_start').map(e => e.data.index));
    for (const e of events.filter(e => e.event.endsWith('_delta') && e.data.index !== undefined)) {
        assert.ok(opened.has(e.data.index), `delta op niet-geopend blok ${e.data.index}`);
    }
    assert.equal(events.filter(e => e.event === 'content_block_stop').length, 2);
});

test('denk-blokken-array in delta (defensief) → alleen tekst naar buiten', () => {
    const { events } = runStream([
        'data: {"id":"m4","choices":[{"index":0,"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"stil"}]},{"type":"text","text":"zichtbaar"}]}}]}\n\n',
        'data: [DONE]\n\n',
    ]);
    const text = events.filter(e => e.event === 'content_block_delta').map(e => e.data.delta.text).join('');
    assert.equal(text, 'zichtbaar');
});

test('lege stream → alsnog een complete reeks', () => {
    const { events } = runStream([]);
    assert.deepEqual(events.map(e => e.event), ['message_start', 'message_delta', 'message_stop']);
    assert.equal(events[1].data.delta.stop_reason, 'end_turn');
});

test('chunk die midden in een regel aankomt wordt correct gebufferd', () => {
    const full = 'data: {"id":"m5","choices":[{"index":0,"delta":{"content":"hoi"}}]}\n\ndata: [DONE]\n\n';
    const { events } = runStream([full.slice(0, 30), full.slice(30, 60), full.slice(60)]);
    const text = events.filter(e => e.event === 'content_block_delta').map(e => e.data.delta.text).join('');
    assert.equal(text, 'hoi');
});

test('sanitizeToolId: onveilige tekens en leeg', () => {
    assert.equal(sanitizeToolId('toolu/01 ab'), 'toolu_01_ab');
    assert.ok(sanitizeToolId('', 'val').startsWith('val'));
    assert.ok(sanitizeToolId(undefined, 'val').startsWith('val'));
});

console.log('');
console.log(`${passed} geslaagd, ${failed} gefaald`);
process.exit(failed === 0 ? 0 : 1);

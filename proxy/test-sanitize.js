#!/usr/bin/env node
/**
 * Unit tests voor de twee wire-patches in model-proxy.js:
 *   1. sanitizeToolSchemas      — \0 → \x00 (24 sep 2026, DeepSeek-schemavalidatie)
 *   2. sanitizeInlineToolBlocks — tool_definition → tool_reference (7 okt 2026, 422-fix)
 *      + stripInlineToolsBeta   — zelfde bèta-token uit de header
 *
 * Draaien:  node proxy/test-sanitize.js     (geen dependencies, exit 1 bij falen)
 */
import { strict as assert } from 'node:assert';
import {
    sanitizeToolSchemas,
    sanitizeInlineToolBlocks,
    stripInlineToolsBeta,
} from './model-proxy.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (err) {
        failed++;
        console.error(`  FAIL ${name}`);
        console.error(`       ${err.message.split('\n')[0]}`);
    }
}

const defBlock = (name) => ({
    type: 'tool_addition',
    tool: { type: 'tool_definition', definition: { name, description: 'test', input_schema: { type: 'object' } } },
});

console.log('sanitizeInlineToolBlocks');

test('tool_definition → tool_reference als de tool in tools[] staat', () => {
    const body = {
        tools: [{ name: 'mcp__x__echo' }],
        messages: [
            { role: 'user', content: [{ type: 'text', text: 'hoi' }] },
            { role: 'system', content: [defBlock('mcp__x__echo')] },
        ],
    };
    const r = sanitizeInlineToolBlocks(body);
    assert.deepEqual(r, { converted: 1, dropped: 0 });
    assert.equal(body.messages.length, 2, 'systeembericht moet blijven');
    const block = body.messages[1].content[0];
    assert.equal(block.type, 'tool_addition');
    assert.deepEqual(block.tool, { type: 'tool_reference', name: 'mcp__x__echo' });
});

test('niet-gedeclareerde tool wordt gedropt; leeg systeembericht verdwijnt', () => {
    const body = {
        tools: [],
        messages: [
            { role: 'user', content: [{ type: 'text', text: 'x' }] },
            { role: 'system', content: [defBlock('mcp__late__tool')] },
        ],
    };
    const r = sanitizeInlineToolBlocks(body);
    assert.deepEqual(r, { converted: 0, dropped: 1 });
    assert.equal(body.messages.length, 1, 'leeg systeembericht moet weg zijn');
    assert.equal(body.messages[0].role, 'user');
});

test('gedeeltelijk geleegd bericht houdt zijn tekst', () => {
    const body = {
        messages: [{ role: 'system', content: [defBlock('mcp__late__tool'), { type: 'text', text: 'blijf' }] }],
    };
    const r = sanitizeInlineToolBlocks(body);
    assert.deepEqual(r, { converted: 0, dropped: 1 });
    assert.equal(body.messages.length, 1);
    assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'blijf' }]);
});

test('tool_reference-blokken en gewone blokken blijven onaangeroerd', () => {
    const body = {
        messages: [{
            role: 'system',
            content: [
                { type: 'tool_addition', tool: { type: 'tool_reference', name: 'mcp__x__echo' } },
                { type: 'text', text: 'a' },
            ],
        }],
    };
    const before = JSON.stringify(body);
    const r = sanitizeInlineToolBlocks(body);
    assert.deepEqual(r, { converted: 0, dropped: 0 });
    assert.equal(JSON.stringify(body), before, 'body mag byte-identiek blijven');
});

test('body zonder tool-blokken blijft dezelfde array-referentie houden', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'a' }] }];
    const body = { messages };
    sanitizeInlineToolBlocks(body);
    assert.equal(body.messages, messages, 'geen onnodige kopie');
});

test('tool_removal met tool_definition wordt ook geconverteerd', () => {
    const body = {
        tools: [{ name: 'mcp__x__echo' }],
        messages: [{
            role: 'system',
            content: [{ type: 'tool_removal', tool: { type: 'tool_definition', definition: { name: 'mcp__x__echo' } } }],
        }],
    };
    const r = sanitizeInlineToolBlocks(body);
    assert.deepEqual(r, { converted: 1, dropped: 0 });
    assert.deepEqual(body.messages[0].content[0], {
        type: 'tool_removal',
        tool: { type: 'tool_reference', name: 'mcp__x__echo' },
    });
});

test('onbekende tool-variant (mcp_toolset_reference) zonder naam wordt gedropt', () => {
    const body = {
        messages: [{
            role: 'system',
            content: [{ type: 'tool_addition', tool: { type: 'mcp_toolset_reference', server: 'mcp__x' } }],
        }],
    };
    const r = sanitizeInlineToolBlocks(body);
    assert.deepEqual(r, { converted: 0, dropped: 1 });
});

test('definitie zonder naam wordt gedropt', () => {
    const body = {
        tools: [{ name: 'x' }],
        messages: [{ role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: {} } }] }],
    };
    const r = sanitizeInlineToolBlocks(body);
    assert.deepEqual(r, { converted: 0, dropped: 1 });
});

test('lege/afwijkende body crasht niet', () => {
    assert.deepEqual(sanitizeInlineToolBlocks({}), { converted: 0, dropped: 0 });
    assert.deepEqual(sanitizeInlineToolBlocks(null), { converted: 0, dropped: 0 });
    assert.deepEqual(sanitizeInlineToolBlocks({ messages: 'kapot' }), { converted: 0, dropped: 0 });
});

test('na de patch bevat de payload nergens meer "tool_definition"', () => {
    const body = {
        tools: [{ name: 'mcp__x__echo' }],
        messages: [
            { role: 'user', content: [{ type: 'text', text: 'x' }] },
            { role: 'system', content: [defBlock('mcp__x__echo'), defBlock('mcp__late__tool')] },
        ],
    };
    sanitizeInlineToolBlocks(body);
    assert.ok(!JSON.stringify(body).includes('tool_definition'));
});

console.log('stripInlineToolsBeta');

test('token wordt uit de komma-lijst gehaald, rest blijft', () => {
    const headers = { 'anthropic-beta': 'mid-conversation-tool-changes-2026-07-01, inline-tools-2026-09-15, advisor-tool-2026-03-01' };
    assert.equal(stripInlineToolsBeta(headers), true);
    assert.equal(headers['anthropic-beta'], 'mid-conversation-tool-changes-2026-07-01,advisor-tool-2026-03-01');
});

test('header verdwijnt als alleen inline-tools erin zat', () => {
    const headers = { 'anthropic-beta': 'inline-tools-2026-09-15' };
    assert.equal(stripInlineToolsBeta(headers), true);
    assert.ok(!('anthropic-beta' in headers));
});

test('toekomstige datums versie van de bèta gaat ook mee', () => {
    const headers = { 'anthropic-beta': 'inline-tools-2026-12-01,effort-2025-11-24' };
    assert.equal(stripInlineToolsBeta(headers), true);
    assert.equal(headers['anthropic-beta'], 'effort-2025-11-24');
});

test('niets te strippen → false, header onaangeroerd', () => {
    const headers = { 'anthropic-beta': 'effort-2025-11-24' };
    assert.equal(stripInlineToolsBeta(headers), false);
    assert.equal(headers['anthropic-beta'], 'effort-2025-11-24');
    assert.equal(stripInlineToolsBeta({}), false);
});

console.log('sanitizeToolSchemas (regressie, 24 sep 2026)');

test('\\0 in een pattern wordt \\x00', () => {
    const body = { tools: [{ name: 'Artifact', input_schema: { properties: { file_paths: { pattern: '^[^\\0]*$' } } } }] };
    assert.equal(sanitizeToolSchemas(body), true);
    assert.equal(body.tools[0].input_schema.properties.file_paths.pattern, '^[^\\x00]*$');
});

test('een letterlijke backslash-0 (\\\\0) blijft staan', () => {
    const body = { tools: [{ name: 'x', input_schema: { pattern: '\\\\0' } }] };
    assert.equal(sanitizeToolSchemas(body), false);
    assert.equal(body.tools[0].input_schema.pattern, '\\\\0');
});

test('tools zonder pattern → geen wijziging', () => {
    const body = { tools: [{ name: 'x', input_schema: { type: 'object' } }] };
    assert.equal(sanitizeToolSchemas(body), false);
});

console.log('');
console.log(`${passed} geslaagd, ${failed} gefaald`);
process.exit(failed === 0 ? 0 : 1);

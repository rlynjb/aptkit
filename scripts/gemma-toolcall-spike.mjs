/**
 * THROWAWAY SPIKE — delete after package A (provider-gemma) is green.
 *
 * Purpose: de-risk the single riskiest assumption in the personal-agent-packages
 * project — that Gemma2:9b (which has NO native tool-calling) can be *prompted*
 * to print a tool call as JSON, and that `parseAgentJson` decodes that messy
 * text back into a clean `ModelToolUseBlock`.
 *
 * This is the inbound text->tool_use path from
 *   docs/personal-agent-packages.md (package A, "the hard part")
 * proven in isolation, before scaffolding the real package + fixture tests.
 *
 * Run (after `ollama pull gemma2:9b`):
 *   node scripts/gemma-toolcall-spike.mjs            # 10 runs, gemma2:9b
 *   node scripts/gemma-toolcall-spike.mjs --runs 20 --model gemma2:9b
 *
 * Reads nothing from the project except `parseAgentJson` — the exact symbol
 * package A will rely on. If this is flaky, you've found the project's biggest
 * risk in an hour, for free.
 */

import { parseArgs } from 'node:util';
import { parseAgentJson } from '@aptkit/runtime';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '10' },
    model: { type: 'string', default: 'gemma2:9b' },
    host: { type: 'string', default: 'http://localhost:11434' },
  },
});

const RUNS = Number.parseInt(values.runs, 10);
const MODEL = values.model;
const HOST = values.host.replace(/\/$/, '');

// One fixture tool with an unambiguous trigger. The spike tests the *mechanics*
// of JSON tool-call emission + decoding, so a tool the model obviously wants to
// call gives the cleanest signal.
const TOOL = {
  name: 'get_weather',
  description: 'Get the current weather for a location.',
  parameters: {
    location: 'string — city name, e.g. "Paris"',
    unit: 'string — "celsius" or "fahrenheit"',
  },
};

// The emulation prompt: render the tool as text and demand a bare JSON tool call.
// This mirrors what package A's provider will do (Gemma can't take a native
// `tools` array, so tools live in the system text).
const SYSTEM = `You are a function-calling assistant. You have exactly one tool:

${JSON.stringify(TOOL, null, 2)}

When the user's request needs this tool, respond with ONLY a single JSON object,
no prose, no markdown prose around it, in this exact shape:

{"tool": "<tool name>", "arguments": { ...arguments... }}

Do not explain. Do not answer in natural language. Emit only the JSON object.`;

const USER = 'What is the weather in Paris right now, in celsius?';

async function callGemma() {
  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  return body?.message?.content ?? '';
}

/**
 * The decode step package A owns: messy text -> ModelToolUseBlock.
 * Returns { ok, block?, reason?, parsed? }.
 */
function decodeToolUse(raw, index) {
  let parsed;
  try {
    parsed = parseAgentJson(raw);
  } catch (err) {
    return { ok: false, reason: `parseAgentJson threw: ${err.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'parsed value is not a JSON object', parsed };
  }
  const name = parsed.tool ?? parsed.name ?? parsed.tool_name;
  const input = parsed.arguments ?? parsed.input ?? parsed.args;
  if (typeof name !== 'string') {
    return { ok: false, reason: 'no string tool name (tool/name)', parsed };
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'no object arguments (arguments/input)', parsed };
  }
  // The clean ModelToolUseBlock package A must produce.
  const block = { type: 'tool_use', id: `spike_${index}`, name, input };
  if (name !== TOOL.name) {
    return { ok: false, reason: `wrong tool name "${name}"`, block };
  }
  return { ok: true, block };
}

function snippet(text, max = 160) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

console.log(`\nGemma tool-call de-risk spike`);
console.log(`  model: ${MODEL}   host: ${HOST}   runs: ${RUNS}\n`);

// Fail fast with a clear message if Ollama/the model isn't ready.
try {
  await callGemma();
} catch (err) {
  console.error(`✖ Cannot reach Gemma. Is the model pulled and Ollama running?`);
  console.error(`  ${err.message}`);
  console.error(`\n  Check:  ollama list   (need "${MODEL}")`);
  process.exit(1);
}

let parseable = 0;
let validToolUse = 0;
const failures = [];

for (let i = 0; i < RUNS; i += 1) {
  let raw = '';
  try {
    raw = await callGemma();
  } catch (err) {
    failures.push({ i, reason: `request failed: ${err.message}`, raw: '' });
    process.stdout.write('E');
    continue;
  }
  const result = decodeToolUse(raw, i);
  // "parseable" = parseAgentJson produced JSON at all (the lower bar).
  if (!String(result.reason ?? '').startsWith('parseAgentJson threw')) parseable += 1;
  if (result.ok) {
    validToolUse += 1;
    process.stdout.write('.');
  } else {
    failures.push({ i, reason: result.reason, raw });
    process.stdout.write('x');
  }
}

const pct = (n) => `${n}/${RUNS} (${Math.round((100 * n) / RUNS)}%)`;
console.log(`\n\n── results ─────────────────────────────────────────`);
console.log(`  parseAgentJson found JSON:     ${pct(parseable)}`);
console.log(`  clean tool_use (right tool):   ${pct(validToolUse)}`);

if (failures.length) {
  console.log(`\n── failures (raw model output) ─────────────────────`);
  for (const f of failures) {
    console.log(`  #${f.i}  ${f.reason}`);
    console.log(`        raw: ${snippet(f.raw)}`);
  }
}

console.log(`\n── verdict ─────────────────────────────────────────`);
const rate = validToolUse / RUNS;
if (rate >= 0.8) {
  console.log(`  ✅ GREEN-LIGHT package A. ${pct(validToolUse)} clean tool calls.`);
  console.log(`     Emulation is reliable enough to build the real provider +`);
  console.log(`     fixture test. A retry-on-parse-fail wrapper will mop up the rest.`);
} else if (rate >= 0.4) {
  console.log(`  ⚠️  SHAKY. ${pct(validToolUse)} clean. Buildable, but package A MUST`);
  console.log(`     wrap generation in a 1–2x parse-retry loop, and the prompt`);
  console.log(`     likely needs hardening (few-shot example, stricter shape).`);
} else {
  console.log(`  ✖ RISK. Only ${pct(validToolUse)} clean. Before committing to`);
  console.log(`     gemma2:9b: try a stricter prompt / few-shot, Ollama's`);
  console.log(`     "format: json" mode, or a more tool-capable local model.`);
}
console.log('');

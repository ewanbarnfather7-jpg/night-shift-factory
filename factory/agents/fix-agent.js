'use strict';
// Fix Agent: proposes a minimal patch for one cluster of failures.
// It never applies anything itself. The orchestrator runs the patch through
// the policy gate, applies it to an isolated workspace copy, and verifies it
// with the factory's own tests (which the Fix Agent cannot touch).

const fs = require('fs');
const path = require('path');
const { listFiles } = require('../lib/util');
const { extractJSON } = require('../lib/llm');
const { redact } = require('./security-agent');

const SYSTEM = [
  'You are the Fix Agent in an overnight software factory for a UK T+1 settlement service used by a bank.',
  'You propose the smallest correct code change that clears one cluster of verified failures.',
  'Rules you must follow:',
  '- Change only files under sut/lib/ or sut/server.js.',
  '- Never change tests, the spec, the reference calendar, the policy, the factory or sut/config.js. Those changes halt the shift.',
  '- Fix the root cause in the service; never special-case the test inputs.',
  '- Keep behaviour outside the defect unchanged and keep the existing code style (CommonJS, no dependencies).',
  '- Return the complete new content of each file you change.',
  'Reply with JSON only: {"rootCause":"...","summary":"one line for the reviewer","files":[{"path":"sut/lib/...","content":"..."}]}',
].join('\n');

function sourceBundle(sutDir) {
  return listFiles(sutDir)
    .filter((rel) => rel.endsWith('.js'))
    .map((rel) => `--- sut/${rel} ---\n${redact(fs.readFileSync(path.join(sutDir, rel), 'utf8'))}`)
    .join('\n\n');
}

function buildPrompt(cluster, ctx, feedback) {
  const criteria = ctx.spec.criteria.filter((c) => cluster.checkIds.includes(c.id));
  const nfrs = ctx.spec.nfr.filter((n) => cluster.checkIds.includes(n.id));
  const contract = JSON.parse(ctx.openapi)['x-nonFunctional'];
  return [
    `Cluster: ${cluster.title} (${cluster.kind})`,
    `Why it was routed to you: ${cluster.route}`,
    '',
    'Verified failures (from the Test, Performance or Security Agent):',
    ...cluster.failures.slice(0, 30).map((f) => `- [${f.checkId}] ${f.detail}`),
    cluster.failures.length > 30 ? `- ... and ${cluster.failures.length - 30} more` : '',
    '',
    criteria.length ? `Acceptance criteria involved:\n${criteria.map((c) => `- ${c.id}: ${c.title}`).join('\n')}` : '',
    nfrs.length ? `NFRs involved:\n${nfrs.map((n) => `- ${n.id}: ${n.method} ${n.path} p95 <= ${n.p95BudgetMs} ms`).join('\n')}` : '',
    `Contract non-functional requirements: ${JSON.stringify(contract)}`,
    `Cutover: trades dated on or after ${ctx.spec.cutoverTradeDate} settle T+1. Deadlines: ${JSON.stringify(ctx.spec.deadlines)} (London time).`,
    '',
    'Current source (secrets redacted):',
    sourceBundle(ctx.sutDir),
    feedback ? `\nYour previous attempt did not pass verification:\n${feedback}\nCorrect it.` : '',
  ].filter((l) => l !== '').join('\n');
}

async function propose(cluster, ctx, { feedback } = {}) {
  const prompt = buildPrompt(cluster, ctx, feedback);
  let raw = '';
  try {
    raw = await ctx.llm.complete(SYSTEM, prompt, { meta: { agent: 'fix-agent', cluster: cluster.kind } });
    const parsed = extractJSON(raw);
    if (!Array.isArray(parsed.files) || !parsed.files.every((f) => f && typeof f.path === 'string' && typeof f.content === 'string')) {
      return { ok: false, reason: 'Response did not include a valid files array', prompt, raw, system: SYSTEM };
    }
    return { ok: true, rootCause: parsed.rootCause || '', summary: parsed.summary || '', files: parsed.files, prompt, raw, system: SYSTEM };
  } catch (err) {
    return { ok: false, reason: err.message, prompt, raw, system: SYSTEM };
  }
}

module.exports = { propose, SYSTEM };

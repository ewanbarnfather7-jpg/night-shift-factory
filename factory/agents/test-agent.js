'use strict';
// Test Agent: turns the acceptance criteria into executable checks and runs
// them against a running service. Every expected result comes from the spec
// or the independent oracle, never from the service itself.
//
// Each result: { id, area, title, status, failures: [{ kind, key, detail }], evidence }
// `kind` decides routing (calendar, convention, allocation-deadline, lifecycle, ...).

const { call, pool } = require('../lib/util');
const { extractJSON } = require('../lib/llm');

const TRADE = { isin: 'GB0002634946', side: 'BUY', quantity: 1000, price: 4.215 };

function dateFailureKind(actual, expected) {
  return actual && actual.convention && actual.convention !== expected.convention ? 'convention' : 'calendar';
}

async function bookTrade(base, tradeDate) {
  const res = await call(base, 'POST', '/trades', { ...TRADE, tradeDate });
  if (res.status !== 201) throw new Error(`Could not capture setup trade: ${res.status} ${res.text.slice(0, 200)}`);
  return res.json;
}

const checks = {
  async 'settlement-date'(base, c) {
    const res = await call(base, 'GET', `/settlement-date?tradeDate=${c.tradeDate}`);
    const expected = { settlementDate: c.expected, convention: c.convention };
    const actual = res.json || { status: res.status, body: res.text.slice(0, 300) };
    const ok = res.status === 200 && res.json.settlementDate === c.expected && res.json.convention === c.convention;
    return {
      failures: ok ? [] : [{ kind: dateFailureKind(res.json, expected), key: c.tradeDate, detail: `Trade ${c.tradeDate}: expected ${c.expected} (${c.convention}), got ${actual.settlementDate || res.status} (${actual.convention || 'n/a'})` }],
      evidence: { request: `GET /settlement-date?tradeDate=${c.tradeDate}`, expected, actual },
    };
  },

  async 'calendar-coverage'(base, c, ctx) {
    const failures = [];
    const years = [];
    for (const year of c.years) {
      const res = await call(base, 'GET', `/calendar/${year}`);
      const loaded = new Set(res.json?.holidays || []);
      const reference = ctx.oracle.holidaysFor(year);
      const missing = reference.filter((d) => !loaded.has(d));
      const extra = [...loaded].filter((d) => !reference.includes(d));
      years.push({ year, loaded: loaded.size, reference: reference.length, missing, extra });
      for (const d of missing) failures.push({ kind: 'calendar', key: `missing:${d}`, detail: `${year} calendar is missing bank holiday ${d}` });
      for (const d of extra) failures.push({ kind: 'calendar', key: `extra:${d}`, detail: `${year} calendar has ${d}, which is not a bank holiday` });
    }
    return { failures, evidence: { years } };
  },

  async 'allocation-deadline'(base, c, ctx) {
    const trade = await bookTrade(base, c.tradeDate);
    const res = await call(base, 'POST', `/trades/${trade.id}/allocations`, {
      fund: 'FUND-ALPHA', quantity: 500, ssiId: 'SSI-CREST-001', receivedAt: c.receivedAt,
    });
    let ok;
    if (c.expect === 'ACCEPTED') ok = res.status === 201;
    else ok = res.status === 422 && res.json?.error === 'LATE_ALLOCATION' && res.json.tradeId === trade.id && res.json.fund === 'FUND-ALPHA' && res.json.escalated === true;
    return {
      failures: ok ? [] : [{
        kind: 'allocation-deadline',
        key: c.receivedAt,
        detail: `Allocation received ${c.receivedAt} for trade date ${c.tradeDate} (cutoff ${ctx.spec.deadlines.allocationCutoff} on T): expected ${c.expect}, got HTTP ${res.status} ${res.json?.error || res.json?.status || ''}`.trim(),
      }],
      evidence: { tradeId: trade.id, receivedAt: c.receivedAt, expected: c.expect, response: { status: res.status, body: res.json } },
    };
  },

  async validation(base, c) {
    const res = await call(base, 'POST', '/trades', c.body);
    const ok = res.status === 400 && Array.isArray(res.json?.fields) && res.json.fields.includes(c.expectField);
    return {
      failures: ok ? [] : [{ kind: 'lifecycle', key: c.id, detail: `Expected 400 naming field "${c.expectField}", got HTTP ${res.status}` }],
      evidence: { body: c.body, response: { status: res.status, body: res.json } },
    };
  },

  async 'duplicate-instruction'(base, c) {
    const trade = await bookTrade(base, c.tradeDate);
    await call(base, 'POST', `/trades/${trade.id}/allocations`, { fund: 'FUND-ALPHA', quantity: 1000, ssiId: 'SSI-CREST-001', receivedAt: `${c.tradeDate}T17:00` });
    const first = await call(base, 'POST', `/trades/${trade.id}/instructions`, {});
    const second = await call(base, 'POST', `/trades/${trade.id}/instructions`, {});
    const ok = first.status === 201 && second.status === 409 && second.json?.error === 'DUPLICATE_INSTRUCTION';
    return {
      failures: ok ? [] : [{ kind: 'lifecycle', key: c.id, detail: `Expected first instruction 201 and duplicate 409, got ${first.status} then ${second.status}` }],
      evidence: { tradeId: trade.id, first: first.status, second: { status: second.status, body: second.json } },
    };
  },

  async sweep(base, c, ctx) {
    const dates = ctx.oracle.businessDays(c.from, c.to);
    const rows = await pool(dates, 8, async (tradeDate) => {
      const res = await call(base, 'GET', `/settlement-date?tradeDate=${tradeDate}`);
      return { tradeDate, expected: ctx.oracle.settle(tradeDate), actual: res.json, status: res.status };
    });
    const mismatches = rows.filter((r) => r.status !== 200 || r.actual.settlementDate !== r.expected.settlementDate || r.actual.convention !== r.expected.convention);
    return {
      failures: mismatches.map((m) => ({
        kind: dateFailureKind(m.actual, m.expected),
        key: m.tradeDate,
        detail: `Trade ${m.tradeDate}: oracle ${m.expected.settlementDate} (${m.expected.convention}), service ${m.actual?.settlementDate || m.status} (${m.actual?.convention || 'n/a'})`,
      })),
      evidence: { checked: rows.length, from: c.from, to: c.to, mismatches: mismatches.slice(0, 50) },
    };
  },
};

async function runCheck(base, c, ctx) {
  try {
    const { failures, evidence } = await checks[c.type](base, c, ctx);
    return { id: c.id, area: c.area, title: c.title, type: c.type, status: failures.length ? 'fail' : 'pass', failures, evidence };
  } catch (err) {
    return { id: c.id, area: c.area, title: c.title, type: c.type, status: 'fail', failures: [{ kind: 'harness', key: c.id, detail: `Check could not run: ${err.message}` }], evidence: {} };
  }
}

/** Run every acceptance criterion. With rerunFailures, failing checks run once more; a pass on rerun is quarantined as flaky. */
async function runFunctional(base, ctx, { rerunFailures = false } = {}) {
  const results = [];
  for (const c of ctx.spec.criteria) {
    let result = await runCheck(base, c, ctx);
    if (rerunFailures && result.status === 'fail' && c.type !== 'sweep') {
      const again = await runCheck(base, c, ctx);
      if (again.status === 'pass') {
        result = { ...result, status: 'flaky', failures: result.failures.map((f) => ({ ...f, kind: 'flaky', detail: `Failed then passed on rerun: ${f.detail}` })) };
      }
    }
    results.push(result);
  }
  return results;
}

/**
 * Exploratory probes proposed by the model from the API contract. Their
 * expected results are AI-generated, so failures are never auto-fixed (POL-07).
 */
async function explore(base, ctx) {
  if (!ctx.llm.available) return { probes: [], results: [], skipped: 'no model configured' };
  const system = 'You are the Test Agent in an overnight test factory for a UK T+1 settlement service. You design exploratory API probes that the existing acceptance criteria do not cover. Reply with JSON only.';
  const prompt = [
    'API contract (OpenAPI):', ctx.openapi,
    '', 'Existing acceptance criteria (do not duplicate these):', JSON.stringify(ctx.spec.criteria.map(({ id, title }) => ({ id, title }))),
    '', 'Propose up to 6 probes for edge cases a settlement operations expert would worry about.',
    'Reply as {"probes":[{"id":"EX-01","rationale":"...","method":"GET|POST","path":"/...","body":{...}|null,"expectStatus":200}]}',
    'Only use paths in the contract. Probes run one at a time with no shared state, so do not use paths that need an existing trade id; use /settlement-date, /calendar/{year} and POST /trades.',
  ].join('\n');
  let probes = [];
  let raw = '';
  try {
    raw = await ctx.llm.complete(system, prompt, { meta: { agent: 'test-agent', task: 'explore' } });
    probes = (extractJSON(raw).probes || []).slice(0, 6);
  } catch (err) {
    return { probes: [], results: [], skipped: `model error: ${err.message}`, prompt, raw };
  }
  const results = [];
  for (const p of probes) {
    const res = await call(base, p.method, p.path, p.body == null ? undefined : p.body);
    const ok = res.status === p.expectStatus;
    results.push({
      id: p.id, area: 'Exploratory', title: p.rationale, type: 'exploratory', status: ok ? 'pass' : 'fail',
      failures: ok ? [] : [{ kind: 'exploratory', key: p.id, detail: `${p.method} ${p.path}: model expected ${p.expectStatus}, got ${res.status}` }],
      evidence: { probe: p, response: { status: res.status, body: res.json || res.text.slice(0, 300) } },
    });
  }
  return { probes, results, prompt, raw };
}

module.exports = { runFunctional, runCheck, explore };

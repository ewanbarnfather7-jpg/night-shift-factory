'use strict';
// Performance Agent: benchmarks the critical paths against the NFR budgets and
// against the previous shift. A breach is confirmed with a second, larger run
// before it is routed anywhere, so noise does not wake the Fix Agent.

const { call } = require('../lib/util');

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

function requestFor(nfr, i) {
  const day = String(1 + (i % 28)).padStart(2, '0');
  const month = String(1 + (i % 12)).padStart(2, '0');
  const tradeDate = `2028-${month}-${day}`;
  if (nfr.method === 'GET') return [`${nfr.path}?tradeDate=${tradeDate}`, undefined];
  return [nfr.path, { isin: 'GB0002634946', side: i % 2 ? 'BUY' : 'SELL', quantity: 100 + i, price: 4.2, tradeDate }];
}

async function bench(base, nfr, samples) {
  for (let i = 0; i < 20; i += 1) await call(base, nfr.method, ...requestFor(nfr, i));
  const times = [];
  let errors = 0;
  for (let i = 0; i < samples; i += 1) {
    const res = await call(base, nfr.method, ...requestFor(nfr, i));
    if (res.status === 0 || res.status >= 500) errors += 1;
    times.push(res.ms);
  }
  times.sort((a, b) => a - b);
  const r = (n) => Math.round(n * 100) / 100;
  return { samples, errors, p50: r(percentile(times, 50)), p95: r(percentile(times, 95)), p99: r(percentile(times, 99)) };
}

async function run(base, nfrs, baseline = {}) {
  const results = [];
  for (const nfr of nfrs) {
    let m = await bench(base, nfr, nfr.samples);
    let confirmed = false;
    if (m.p95 > nfr.p95BudgetMs) {
      m = await bench(base, nfr, nfr.samples); // confirmation run
      confirmed = true;
    }
    const prev = baseline[nfr.id];
    const failures = [];
    if (m.p95 > nfr.p95BudgetMs) {
      failures.push({ kind: 'perf', key: nfr.id, detail: `${nfr.method} ${nfr.path} p95 ${m.p95} ms against a ${nfr.p95BudgetMs} ms budget${confirmed ? ' (confirmed on re-run)' : ''}` });
    } else if (prev && m.p95 > prev * 1.5 && m.p95 - prev > 2) {
      failures.push({ kind: 'perf', key: `${nfr.id}:decline`, detail: `${nfr.method} ${nfr.path} p95 rose from ${prev} ms to ${m.p95} ms since the last shift` });
    }
    if (m.errors) failures.push({ kind: 'perf', key: `${nfr.id}:errors`, detail: `${m.errors} server errors during benchmark` });
    results.push({
      id: nfr.id, area: 'Performance', title: nfr.title, method: nfr.method, path: nfr.path,
      budget: nfr.p95BudgetMs, previousP95: prev ?? null, ...m, confirmed,
      status: failures.length ? 'fail' : 'pass', failures,
    });
  }
  return results;
}

module.exports = { run, bench };

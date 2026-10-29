'use strict';
// QA Agent: compares tonight's failures with the last shift's baseline.
// new     - first seen tonight (a regression if it passed last shift)
// known   - still failing from a previous shift
// fixed   - failing last shift, passing tonight

const keyOf = (f) => `${f.checkId}|${f.kind}|${f.key}`;

function classify(failures, baseline) {
  const prior = new Set(baseline?.failureKeys || []);
  const now = new Set(failures.map(keyOf));
  const tagged = failures.map((f) => ({ ...f, trend: !baseline ? 'new' : prior.has(keyOf(f)) ? 'known' : 'new' }));
  const fixed = [...prior].filter((k) => !now.has(k)).map((k) => {
    const [checkId, kind, key] = k.split('|');
    return { checkId, kind, key };
  });
  const regressions = baseline ? tagged.filter((f) => f.trend === 'new') : [];
  return {
    hasBaseline: Boolean(baseline),
    baselineShift: baseline?.shiftId || null,
    failures: tagged,
    counts: {
      new: tagged.filter((f) => f.trend === 'new').length,
      known: tagged.filter((f) => f.trend === 'known').length,
      fixed: fixed.length,
    },
    fixed,
    regressions,
  };
}

module.exports = { classify, keyOf };

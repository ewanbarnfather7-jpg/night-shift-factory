'use strict';
// Independent test oracle for settlement dates. Deliberately shares no code
// with the service: its holiday calendar comes from spec/reference/.

const DAY_MS = 24 * 60 * 60 * 1000;

function makeOracle(reference, cutoverTradeDate) {
  const holidays = new Set(Object.values(reference.years).flat());
  const toDate = (iso) => new Date(`${iso}T00:00:00Z`);
  const toIso = (d) => d.toISOString().slice(0, 10);
  const isBusinessDay = (iso) => {
    const day = toDate(iso).getUTCDay();
    return day !== 0 && day !== 6 && !holidays.has(iso);
  };
  const convention = (tradeDate) => (tradeDate >= cutoverTradeDate ? 'T+1' : 'T+2');
  const settle = (tradeDate) => {
    const conv = convention(tradeDate);
    let n = conv === 'T+1' ? 1 : 2;
    let t = toDate(tradeDate).getTime();
    while (n > 0) {
      t += DAY_MS;
      if (isBusinessDay(toIso(new Date(t)))) n -= 1;
    }
    return { settlementDate: toIso(new Date(t)), convention: conv };
  };
  const businessDays = (from, to) => {
    const out = [];
    for (let t = toDate(from).getTime(); t <= toDate(to).getTime(); t += DAY_MS) {
      const iso = toIso(new Date(t));
      if (isBusinessDay(iso)) out.push(iso);
    }
    return out;
  };
  return { settle, isBusinessDay, businessDays, holidaysFor: (y) => (reference.years[String(y)] || []).slice() };
}

module.exports = { makeOracle };

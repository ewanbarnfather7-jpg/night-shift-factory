'use strict';
// Settlement date derivation: T+2 before the UK cutover, T+1 from it.

const config = require('../config');
const calendar = require('./calendar');

const DAY_MS = 24 * 60 * 60 * 1000;

function parse(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function format(date) {
  return date.toISOString().slice(0, 10);
}

function addBusinessDays(iso, n) {
  let date = parse(iso);
  let remaining = n;
  while (remaining > 0) {
    date = new Date(date.getTime() + DAY_MS);
    if (calendar.isBusinessDay(format(date))) remaining -= 1;
  }
  return format(date);
}

function conventionFor(tradeDate) {
  return tradeDate > config.t1CutoverTradeDate ? 'T+1' : 'T+2';
}

function settlementDate(tradeDate) {
  const convention = conventionFor(tradeDate);
  const days = convention === 'T+1' ? 1 : 2;
  return { tradeDate, convention, settlementDate: addBusinessDays(tradeDate, days) };
}

module.exports = { settlementDate, addBusinessDays, conventionFor };

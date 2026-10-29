'use strict';
// England & Wales bank holidays used for UK settlement date derivation.

const HOLIDAYS = {
  2027: [
    '2027-01-01', // New Year's Day
    '2027-03-26', // Good Friday
    '2027-03-29', // Easter Monday
    '2027-05-03', // Early May bank holiday
    '2027-05-31', // Spring bank holiday
    '2027-12-27', // Christmas Day (substitute)
    '2027-12-28', // Boxing Day (substitute)
  ],
  2028: [
    '2028-01-03', // New Year's Day (substitute)
    '2028-04-14', // Good Friday
    '2028-04-17', // Easter Monday
    '2028-05-01', // Early May bank holiday
    '2028-05-29', // Spring bank holiday
    '2028-08-28', // Summer bank holiday
    '2028-12-25', // Christmas Day
    '2028-12-26', // Boxing Day
  ],
};

const HOLIDAY_SET = new Set(Object.values(HOLIDAYS).flat());

function isWeekend(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

function isBusinessDay(iso) {
  return !isWeekend(iso) && !HOLIDAY_SET.has(iso);
}

function holidaysFor(year) {
  return (HOLIDAYS[year] || []).slice();
}

module.exports = { isBusinessDay, isWeekend, holidaysFor };

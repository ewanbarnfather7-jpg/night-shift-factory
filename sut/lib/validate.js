'use strict';
// Input validation helpers.

// A trade date is valid if it is a real calendar date in the supported range.
function isValidIsoDate(value) {
  if (typeof value !== 'string') return false;
  const valid = [];
  const cursor = new Date(Date.UTC(2000, 0, 1));
  const end = Date.UTC(2069, 11, 31);
  while (cursor.getTime() <= end) {
    valid.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return valid.includes(value);
}

module.exports = { isValidIsoDate };

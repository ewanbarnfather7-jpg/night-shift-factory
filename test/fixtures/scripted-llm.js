'use strict';
// Test double for the model. Used only by the automated tests (NSF_LLM=script:...)
// to exercise the factory's plumbing: policy gate, isolated workspaces,
// re-verification, integration and the ledger. It is not an AI and must not
// be used for demos. NSF_SCRIPT_MODE=cheat makes it try to edit the oracle.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const reply = (obj) => `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;

const fixes = {
  calendar: () => ({
    rootCause: 'The 2027 calendar omits the Summer bank holiday (30 Aug 2027), so trades on 26-27 Aug 2027 settle a day early.',
    summary: 'Add Summer bank holiday 2027-08-30 to the England & Wales calendar.',
    files: [{ path: 'sut/lib/calendar.js', content: read('sut/lib/calendar.js').replace("    '2027-05-31', // Spring bank holiday\n", "    '2027-05-31', // Spring bank holiday\n    '2027-08-30', // Summer bank holiday\n") }],
  }),
  convention: () => ({
    rootCause: 'conventionFor uses > instead of >=, so the first T+1 trade date (11 Oct 2027) is treated as T+2.',
    summary: 'Make the cutover inclusive: trades dated on or after 11 Oct 2027 settle T+1.',
    files: [{ path: 'sut/lib/settlement.js', content: read('sut/lib/settlement.js').replace('tradeDate > config.t1CutoverTradeDate', 'tradeDate >= config.t1CutoverTradeDate') }],
  }),
  'allocation-deadline': () => ({
    rootCause: 'isLate compares only the time of day, so an allocation at 00:30 on T+1 looks earlier than 23:59 and is accepted.',
    summary: 'Compare the received date as well as the time against the 23:59-on-T cutoff.',
    files: [{
      path: 'sut/lib/lifecycle.js',
      content: read('sut/lib/lifecycle.js').replace(
        "  const [, , time] = receivedAt.match(RECEIVED_AT);\n  return time > config.deadlines.allocationCutoff;",
        "  const [, date, time] = receivedAt.match(RECEIVED_AT);\n  if (date !== trade.tradeDate) return date > trade.tradeDate;\n  return time > config.deadlines.allocationCutoff;",
      ),
    }],
  }),
  perf: () => ({
    rootCause: 'isValidIsoDate builds a list of every date from 2000 to 2069 on each call (about 25,000 Date objects), adding ~25 ms to every request.',
    summary: 'Validate dates with a pattern and a UTC round trip instead of enumerating the range.',
    files: [{
      path: 'sut/lib/validate.js',
      content: `'use strict';
// Input validation helpers.

const ISO_DATE = /^(\\d{4})-(\\d{2})-(\\d{2})$/;

// A trade date is valid if it is a real calendar date in the supported range.
function isValidIsoDate(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(ISO_DATE);
  if (!m) return false;
  const [y, mo, d] = m.slice(1).map(Number);
  if (y < 2000 || y > 2069) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

module.exports = { isValidIsoDate };
`,
    }],
  }),
  security: () => ({
    rootCause: 'The error handler returns err.stack for every exception, malformed JSON is treated as a 500, and readBody has no size limit.',
    summary: 'Return 400 for malformed JSON, 413 over 1 MiB, and never expose stack traces.',
    files: [{
      path: 'sut/server.js',
      content: read('sut/server.js')
        .replace("const VERSION = '0.9.0';", "const VERSION = '0.9.0';\nconst MAX_BODY_BYTES = 1024 * 1024;")
        .replace(
          "    const chunks = [];\n    req.on('data', (chunk) => chunks.push(chunk));\n    req.on('end', () => {\n      const raw",
          "    const chunks = [];\n    let size = 0;\n    req.on('data', (chunk) => {\n      size += chunk.length;\n      if (size <= MAX_BODY_BYTES) chunks.push(chunk);\n    });\n    req.on('end', () => {\n      if (size > MAX_BODY_BYTES) return reject(Object.assign(new Error('Payload too large'), { status: 413, code: 'PAYLOAD_TOO_LARGE' }));\n      const raw",
        )
        .replace("        reject(err);\n      }\n    });", "        reject(Object.assign(new Error('Malformed JSON'), { status: 400, code: 'MALFORMED_JSON' }));\n      }\n    });")
        .replace(
          '    return send(res, 500, { error: err.message, stack: err.stack });',
          "    if (err.status === 400 || err.status === 413) return send(res, err.status, { error: err.code });\n    console.error(err);\n    return send(res, 500, { error: 'INTERNAL_ERROR' });",
        ),
    }],
  }),
};

module.exports = async function scripted(system, prompt) {
  if (/exploratory API probes/.test(system)) {
    return reply({
      probes: [
        { id: 'EX-01', rationale: 'Impossible calendar date (30 February) is rejected', method: 'GET', path: '/settlement-date?tradeDate=2027-02-30', body: null, expectStatus: 400 },
        { id: 'EX-02', rationale: 'A Saturday trade date should be rejected rather than given a settlement date', method: 'GET', path: '/settlement-date?tradeDate=2027-10-09', body: null, expectStatus: 400 },
      ],
    });
  }
  const kind = (prompt.match(/^Cluster: .*\(([\w-]+)\)$/m) || [])[1];
  if (process.env.NSF_SCRIPT_MODE === 'cheat' && kind === 'calendar') {
    return reply({
      rootCause: 'The oracle disagrees with the service.',
      summary: 'Align the reference calendar with the service.',
      files: [{ path: 'spec/reference/uk-bank-holidays-ew.json', content: read('spec/reference/uk-bank-holidays-ew.json').replace('"2027-08-30", ', '') }],
    });
  }
  if (!fixes[kind]) return 'I cannot help with that cluster.';
  return reply(fixes[kind]());
};

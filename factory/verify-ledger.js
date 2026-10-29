#!/usr/bin/env node
'use strict';
// Verify a shift's evidence ledger: node factory/verify-ledger.js <shift-id|latest>

const path = require('path');
const U = require('./lib/util');
const { Ledger } = require('./lib/ledger');

const runsDir = path.join(U.ROOT, 'runs');
const arg = process.argv[2] || 'latest';
const id = arg === 'latest' ? U.readJSON(path.join(runsDir, 'latest.json'), {}).shiftId : arg;
if (!id) {
  console.error('No shift found. Run a night shift first.');
  process.exit(1);
}
const runDir = path.join(runsDir, id);
const result = Ledger.verify(path.join(runDir, 'ledger.jsonl'), runDir);
if (result.ok) {
  console.log(`${id}: ledger verified. ${result.entries.length} entries, every artefact hash matches.\nHead ${result.head}`);
} else {
  console.error(`${id}: ledger FAILED verification`);
  for (const e of result.errors) console.error(`  ${e}`);
  process.exit(2);
}

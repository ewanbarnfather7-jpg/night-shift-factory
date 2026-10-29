#!/usr/bin/env node
'use strict';
// Human sign-off for a PR from the morning pack. The reviewer's decision is
// written to the shift's evidence ledger; an approval applies the change to sut/.
//
//   node factory/signoff.js --shift <id|latest> --pr PR-001 --approve --reviewer "Name" [--reference-checked "source"] [--note "..."]
//   node factory/signoff.js --shift <id|latest> --pr PR-002 --reject  --reviewer "Name" --note "why"

const fs = require('fs');
const path = require('path');
const U = require('./lib/util');
const { Ledger } = require('./lib/ledger');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--approve' || a === '--reject') out.decision = a.slice(2);
    else if (a.startsWith('--')) out[a.slice(2).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = argv[++i];
  }
  return out;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const a = args(process.argv.slice(2));
if (!a.shift || !a.pr || !a.decision || !a.reviewer) fail('Usage: node factory/signoff.js --shift <id|latest> --pr PR-001 --approve|--reject --reviewer "Name" [--reference-checked "source"] [--note "..."]');

const runsDir = path.join(U.ROOT, 'runs');
const shiftId = a.shift === 'latest' ? U.readJSON(path.join(runsDir, 'latest.json'), {}).shiftId : a.shift;
const runDir = path.join(runsDir, shiftId || '');
const prFile = path.join(runDir, 'prs', a.pr, 'pr.json');
if (!fs.existsSync(prFile)) fail(`No ${a.pr} in shift ${shiftId}.`);

const check = Ledger.verify(path.join(runDir, 'ledger.jsonl'), runDir);
if (!check.ok) fail(`Refusing: the evidence ledger for ${shiftId} fails verification.\n${check.errors.join('\n')}`);

// pr.json is evidence (its hash is in the ledger), so it is never edited.
// The reviewer's decision goes into its own file next to it.
const pr = U.readJSON(prFile);
const decisionFile = path.join(runDir, 'prs', a.pr, 'decision.json');
if (fs.existsSync(decisionFile)) fail(`${a.pr} was already ${U.readJSON(decisionFile).decision} by ${U.readJSON(decisionFile).by}.`);

const ledger = new Ledger(path.join(runDir, 'ledger.jsonl'), runDir);

if (a.decision === 'reject') {
  if (!a.note) fail('Say why with --note so the Fix Agent and the audit trail have the reason.');
  U.writeJSON(decisionFile, { pr: a.pr, decision: 'rejected', by: a.reviewer, at: new Date().toISOString(), note: a.note });
  ledger.append({ agent: `human:${a.reviewer}`, action: `${a.pr}.rejected`, summary: a.note, artefacts: [decisionFile] });
  console.log(`${a.pr} rejected and recorded in the ledger.`);
  process.exit(0);
}

if (pr.policyOutcome === 'REFERENCE_CHECK_REQUIRED' && !a.referenceChecked) {
  fail(`${a.pr} changes reference data. ${pr.policyFlags.map((f) => f.detail).join(' ')}\nAdd --reference-checked "<the source you checked>".`);
}

// The service must not have changed since the PR was verified.
const stale = pr.files.filter((f) => {
  const abs = path.join(U.ROOT, f.path);
  const now = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  return U.sha256(now) !== f.baseSha;
});
if (stale.length) fail(`Refusing: ${stale.map((f) => f.path).join(', ')} changed since ${a.pr} was verified. Re-run the night shift to get a fresh PR.`);

for (const f of pr.files) U.writeText(path.join(U.ROOT, f.path), f.content);
const decision = { pr: a.pr, decision: 'approved', by: a.reviewer, at: new Date().toISOString(), note: a.note || null, referenceChecked: a.referenceChecked || null, files: pr.files.map((f) => f.path) };
U.writeJSON(decisionFile, decision);
ledger.append({
  agent: `human:${a.reviewer}`, action: `${a.pr}.approved`,
  summary: `Applied ${pr.files.map((f) => f.path).join(', ')}${a.referenceChecked ? `; reference checked against ${a.referenceChecked}` : ''}`,
  data: decision, artefacts: [decisionFile, prFile],
});
console.log(`${a.pr} approved by ${a.reviewer} and applied to ${pr.files.map((f) => f.path).join(', ')}. The next shift will confirm it.`);

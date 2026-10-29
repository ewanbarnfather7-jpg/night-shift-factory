'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Ledger } = require('../factory/lib/ledger');
const { evaluatePatch } = require('../factory/lib/policy');
const { makeOracle } = require('../factory/lib/oracle');
const { redact, scanSecrets } = require('../factory/agents/security-agent');

const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'policy.json'), 'utf8'));
const reference = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'reference', 'uk-bank-holidays-ew.json'), 'utf8'));

test('ledger detects an altered artefact and an altered entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsf-ledger-'));
  const art = path.join(dir, 'evidence.json');
  fs.writeFileSync(art, '{"ok":true}');
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'), dir);
  ledger.append({ agent: 'test-agent', action: 'a', artefacts: [art] });
  ledger.append({ agent: 'fix-agent', action: 'b' });
  assert.equal(Ledger.verify(ledger.file, dir).ok, true);

  fs.writeFileSync(art, '{"ok":false}');
  const afterArtefact = Ledger.verify(ledger.file, dir);
  assert.equal(afterArtefact.ok, false);
  assert.match(afterArtefact.errors[0], /artefact altered/);

  fs.writeFileSync(art, '{"ok":true}');
  const text = fs.readFileSync(ledger.file, 'utf8').replace('"action":"b"', '"action":"c"');
  fs.writeFileSync(ledger.file, text);
  assert.match(Ledger.verify(ledger.file, dir).errors.join(), /contents altered/);
});

test('policy gate halts on protected paths and flags reference data', () => {
  assert.equal(evaluatePatch([{ path: 'spec/reference/uk-bank-holidays-ew.json', changedLines: 1 }], policy).outcome, 'HALT_SHIFT');
  assert.equal(evaluatePatch([{ path: 'test/unit.test.js', changedLines: 1 }], policy).outcome, 'HALT_SHIFT');
  assert.equal(evaluatePatch([{ path: 'sut/../spec/policy.json', changedLines: 1 }], policy).outcome, 'HALT_SHIFT');
  assert.equal(evaluatePatch([{ path: '../outside.js', changedLines: 1 }], policy).outcome, 'HALT_SHIFT');
  assert.equal(evaluatePatch([{ path: 'sut/openapi.json', changedLines: 1 }], policy).outcome, 'REJECT_PATCH');
  assert.equal(evaluatePatch([{ path: 'sut/lib/settlement.js', changedLines: 500 }], policy).outcome, 'REJECT_PATCH');
  assert.equal(evaluatePatch([{ path: 'sut/lib/calendar.js', changedLines: 1 }], policy).outcome, 'REFERENCE_CHECK_REQUIRED');
  assert.equal(evaluatePatch([{ path: 'sut/lib/settlement.js', changedLines: 2 }], policy).outcome, 'READY_FOR_REVIEW');
});

test('oracle matches the T+1 scenario pack', () => {
  const oracle = makeOracle(reference, '2027-10-11');
  assert.deepEqual(oracle.settle('2027-10-08'), { settlementDate: '2027-10-12', convention: 'T+2' });
  assert.deepEqual(oracle.settle('2027-10-11'), { settlementDate: '2027-10-12', convention: 'T+1' });
  assert.equal(oracle.settle('2027-12-24').settlementDate, '2027-12-29');
  assert.equal(oracle.settle('2027-08-27').settlementDate, '2027-09-01');
});

test('secrets are found and never leave in a prompt', () => {
  const sutDir = path.join(__dirname, '..', 'sut');
  const config = fs.readFileSync(path.join(sutDir, 'config.js'), 'utf8');
  const findings = scanSecrets(sutDir);
  if (/_live_/.test(config)) assert.ok(findings.some((f) => f.location === 'sut/config.js:19' || f.location.startsWith('sut/config.js')));
  const redacted = redact(config);
  assert.doesNotMatch(redacted, /crst_live_[A-Za-z0-9]{16,}/);
  assert.match(redacted, /gatewayUrl: 'https:\/\/crest-gateway/);
});

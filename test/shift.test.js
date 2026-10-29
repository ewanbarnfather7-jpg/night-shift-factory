'use strict';
// End-to-end: runs a real shift on a temporary copy of the project, with the
// scripted test double standing in for the model. Takes a couple of minutes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function copyProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsf-e2e-'));
  for (const part of ['sut', 'spec', 'factory', 'test']) fs.cpSync(path.join(ROOT, part), path.join(dir, part), { recursive: true });
  return dir;
}

function shift(dir, env = {}) {
  const res = spawnSync(process.execPath, ['factory/orchestrator.js', '--no-explore'], {
    cwd: dir, encoding: 'utf8', timeout: 600000,
    env: { ...process.env, NSF_LLM: 'script:test/fixtures/scripted-llm.js', ...env },
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const latest = JSON.parse(fs.readFileSync(path.join(dir, 'runs', 'latest.json'), 'utf8'));
  return JSON.parse(fs.readFileSync(path.join(dir, 'runs', latest.shiftId, 'morning-pack.json'), 'utf8'));
}

test('a cheating fix halts the shift and changes nothing', { timeout: 600000 }, () => {
  const dir = copyProject();
  const before = fs.readFileSync(path.join(dir, 'spec', 'reference', 'uk-bank-holidays-ew.json'), 'utf8');
  const pack = shift(dir, { NSF_SCRIPT_MODE: 'cheat' });
  assert.equal(pack.release.state, 'HALTED');
  assert.equal(pack.halted.rule, 'POL-02');
  assert.equal(pack.prs.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'spec', 'reference', 'uk-bank-holidays-ew.json'), 'utf8'), before);
  assert.equal(pack.ledger.ok, true);
});

test('full shift: fixes verified, sign-off applied, next shift sees them fixed', { timeout: 900000 }, () => {
  const dir = copyProject();
  const first = shift(dir);
  assert.equal(first.release.state, 'BLOCKED'); // the leaked credential
  assert.deepEqual(first.prs.map((p) => p.kind).sort(), ['allocation-deadline', 'calendar', 'convention', 'perf', 'security']);
  assert.equal(first.integration.verified, true);

  for (const pr of first.prs) {
    const extra = pr.policyOutcome === 'REFERENCE_CHECK_REQUIRED' ? ['--reference-checked', 'gov.uk bank holidays'] : [];
    const res = spawnSync(process.execPath, ['factory/signoff.js', '--shift', first.id, '--pr', pr.id, '--approve', '--reviewer', 'Test Reviewer', ...extra], { cwd: dir, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
  }
  const verify = spawnSync(process.execPath, ['factory/verify-ledger.js', first.id], { cwd: dir, encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stderr);

  const second = shift(dir);
  assert.equal(second.prs.length, 0);
  assert.equal(second.qa.counts.new, 0);
  assert.ok(second.qa.counts.fixed >= 10);
  assert.equal(second.release.state, 'BLOCKED'); // still blocked until a human rotates the key
});

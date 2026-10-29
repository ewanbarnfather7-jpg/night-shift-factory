#!/usr/bin/env node
'use strict';
// Night shift orchestrator.
//
//   observe   Test, Performance and Security Agents run against the service
//   classify  QA Agent compares with the last shift (new / known / fixed)
//   gate      Policy gate turns findings into risk flags (secrets block release)
//   route     Failures are clustered by root cause and routed
//   fix       Fix Agent proposes a patch per cluster -> policy gate -> isolated
//             workspace -> full re-verification with the factory's own tests
//   integrate All verified PRs merged into one candidate and verified together
//   report    Morning pack for the human "editor-in-chief"; nothing auto-merges
//
// Usage: node factory/orchestrator.js [--no-fix] [--no-explore] [--label "text"]

const fs = require('fs');
const path = require('path');
const U = require('./lib/util');
const { Ledger } = require('./lib/ledger');
const { makeOracle } = require('./lib/oracle');
const { LLM } = require('./lib/llm');
const { evaluatePatch, normalise } = require('./lib/policy');
const testAgent = require('./agents/test-agent');
const securityAgent = require('./agents/security-agent');
const perfAgent = require('./agents/perf-agent');
const qaAgent = require('./agents/qa-agent');
const fixAgent = require('./agents/fix-agent');
const { writeMorningPack } = require('./morning-pack');

const CLUSTERS = {
  calendar: { title: 'Settlement calendar is wrong', risk: 'High', route: 'Settlement dates are wrong while the convention is right, which points at the holiday calendar.' },
  convention: { title: 'Wrong settlement convention at the T+1 cutover', risk: 'High', route: 'The service applied the wrong convention (T+1 vs T+2) for the trade date.' },
  'allocation-deadline': { title: 'Allocation deadline (SETT 01) not enforced', risk: 'High', route: 'Allocation checks at the 23:59-on-T boundary failed.' },
  lifecycle: { title: 'Trade lifecycle rule broken', risk: 'Medium', route: 'Lifecycle acceptance criteria failed.' },
  perf: { title: 'Performance budget breached', risk: 'Medium', route: 'The Performance Agent confirmed a p95 breach on a second, larger run.' },
  security: { title: 'Security hardening against the contract', risk: 'Medium', route: 'Security Agent probes failed against the contract.' },
};

const ROUTING = [
  { when: 'Functional failure, consistent on rerun', to: 'Fix Agent, one PR per root-cause cluster' },
  { when: 'Functional failure that passes on rerun', to: 'Quarantined as flaky, human triage' },
  { when: 'p95 over budget', to: 'Performance Agent confirmation run, then Fix Agent' },
  { when: 'Security probe failure', to: 'Fix Agent' },
  { when: 'Secret in source (POL-01)', to: 'Release blocked, human rotates the credential; never sent to a model' },
  { when: 'Exploratory probe failure (POL-07)', to: 'Human triage, because the expected result is AI-generated' },
  { when: 'Patch touches a protected path (POL-02)', to: 'Patch discarded, shift halted' },
  { when: 'Every verified fix (POL-05)', to: 'Morning review queue; nothing merges automatically' },
];

const UNROUTED = new Set(['secret', 'exploratory', 'flaky', 'harness']);

function parseArgs(argv) {
  const args = { fix: true, explore: true, label: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--no-fix') args.fix = false;
    else if (argv[i] === '--no-explore') args.explore = false;
    else if (argv[i] === '--label') args.label = argv[++i] || '';
  }
  return args;
}

const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)}  ${msg}`);

function flatten(obs) {
  const out = [];
  for (const r of obs.functional) for (const f of r.failures) out.push({ ...f, checkId: r.id, source: 'test-agent' });
  for (const r of obs.perf) for (const f of r.failures) out.push({ ...f, checkId: r.id, source: 'perf-agent' });
  for (const s of obs.security) out.push({ kind: s.kind, key: s.key, checkId: s.id, detail: s.detail, severity: s.severity, source: 'security-agent' });
  for (const r of obs.exploratory?.results || []) for (const f of r.failures) out.push({ ...f, checkId: r.id, source: 'test-agent' });
  return out;
}

async function observe(ctx, base, sutDir, outDir, { phase, rerun = false, explore = false, baselinePerf = {} }) {
  const functional = await testAgent.runFunctional(base, ctx, { rerunFailures: rerun });
  const fFile = U.writeJSON(path.join(outDir, 'functional.json'), functional);
  const passed = functional.filter((r) => r.status === 'pass').length;
  ctx.ledger.append({ agent: 'test-agent', action: `${phase}.functional`, summary: `${passed}/${functional.length} acceptance checks passed`, artefacts: [fFile] });

  const perf = await perfAgent.run(base, ctx.spec.nfr, baselinePerf);
  const pFile = U.writeJSON(path.join(outDir, 'perf.json'), perf);
  ctx.ledger.append({ agent: 'perf-agent', action: `${phase}.benchmark`, summary: perf.map((p) => `${p.id} p95 ${p.p95}ms/${p.budget}ms`).join('; '), artefacts: [pFile] });

  const security = [...securityAgent.scanSecrets(sutDir), ...(await securityAgent.probe(base))];
  const sFile = U.writeJSON(path.join(outDir, 'security.json'), security);
  ctx.ledger.append({ agent: 'security-agent', action: `${phase}.scan`, summary: `${security.length} finding(s)`, artefacts: [sFile] });

  let exploratory = null;
  if (explore && ctx.llm.available) {
    exploratory = await testAgent.explore(base, ctx);
    const eFile = U.writeJSON(path.join(outDir, 'exploratory.json'), exploratory);
    ctx.ledger.append({ agent: 'test-agent', action: `${phase}.explore`, model: ctx.llm.label(), summary: exploratory.skipped || `${exploratory.results.length} AI-generated probe(s)`, artefacts: [eFile] });
  }

  const obs = { functional, perf, security, exploratory };
  obs.failures = flatten(obs);
  return obs;
}

async function runFixCluster(cluster, prId, ctx, obs, shift) {
  const { policy, llm, ledger } = ctx;
  const prDir = path.join(ctx.runDir, 'prs', prId);
  const baseKeys = new Set(obs.failures.map(qaAgent.keyOf));
  const attempts = [];
  let feedback = null;

  for (let n = 1; n <= policy.fixAgent.maxAttempts; n += 1) {
    if (llm.calls >= llm.maxCalls) {
      attempts.push({ n, result: 'budget', detail: 'Model call budget for the shift is used up' });
      break;
    }
    const aDir = path.join(prDir, `attempt-${n}`);
    log(`  ${prId} attempt ${n}: Fix Agent working on "${cluster.title}"`);
    const proposal = await fixAgent.propose(cluster, ctx, { feedback });
    const promptFile = U.writeText(path.join(aDir, 'prompt.txt'), `SYSTEM:\n${proposal.system}\n\nUSER:\n${proposal.prompt}`);
    const responseFile = U.writeText(path.join(aDir, 'response.txt'), proposal.raw || '');
    ledger.append({
      agent: 'fix-agent', action: `${prId}.attempt-${n}.propose`, model: llm.label(),
      summary: proposal.ok ? proposal.summary : `No usable patch: ${proposal.reason}`,
      artefacts: [promptFile, responseFile],
    });
    if (!proposal.ok) {
      attempts.push({ n, result: 'invalid-response', detail: proposal.reason });
      feedback = `Your response could not be used: ${proposal.reason}. Reply with the JSON object only.`;
      continue;
    }

    // Path rules first, before anything is read or written.
    const pathVerdict = evaluatePatch(proposal.files.map((f) => ({ path: f.path, changedLines: 0 })), policy);
    let files = [];
    let verdict = pathVerdict;
    if (pathVerdict.outcome !== 'HALT_SHIFT' && !pathVerdict.violations.some((v) => /Outside allowed/.test(v.detail))) {
      files = proposal.files.map((f) => {
        const rel = normalise(f.path);
        const abs = path.join(ctx.root, rel);
        const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
        const { patch, changedLines } = U.unifiedDiff(rel, before, f.content, path.join(aDir, '.diff-scratch'));
        return { path: rel, before, content: f.content, patch, changedLines, baseSha: U.sha256(before) };
      }).filter((f) => f.content !== f.before);
      verdict = evaluatePatch(files, policy);
    }
    const verdictFile = U.writeJSON(path.join(aDir, 'policy-verdict.json'), verdict);
    ledger.append({ agent: 'policy-gate', action: `${prId}.attempt-${n}.evaluate`, summary: verdict.outcome, data: { violations: verdict.violations, flags: verdict.flags }, artefacts: [verdictFile] });

    if (verdict.outcome === 'HALT_SHIFT') {
      attempts.push({ n, result: 'halted', detail: verdict.violations.map((v) => v.detail).join('; ') });
      shift.halt(`Fix Agent tried to change a protected path while working on ${prId} (${verdict.violations.map((v) => v.detail).join('; ')}). Patch discarded.`, 'POL-02');
      return { id: prId, status: 'halted', cluster, attempts, verdict };
    }
    if (verdict.outcome === 'REJECT_PATCH') {
      attempts.push({ n, result: 'rejected', detail: verdict.violations.map((v) => v.detail).join('; ') });
      feedback = `The policy gate rejected the patch: ${verdict.violations.map((v) => v.detail).join('; ')}`;
      continue;
    }

    // Apply to an isolated copy of the service, never the main tree.
    const ws = path.join(aDir, 'workspace');
    fs.cpSync(ctx.sutDir, path.join(ws, 'sut'), { recursive: true });
    for (const f of files) U.writeText(path.join(ws, f.path), f.content);
    const patchFile = U.writeText(path.join(aDir, 'patch.diff'), files.map((f) => f.patch).join('\n'));

    let instance;
    try {
      instance = await U.startSut(path.join(ws, 'sut'), path.join(aDir, 'sut.log'));
    } catch (err) {
      attempts.push({ n, result: 'did-not-start', detail: err.message.slice(0, 500) });
      feedback = `The patched service failed to start:\n${err.message.slice(-1500)}`;
      ledger.append({ agent: 'orchestrator', action: `${prId}.attempt-${n}.verdict`, summary: 'Patched service did not start', artefacts: [patchFile] });
      continue;
    }
    let verification;
    try {
      log(`  ${prId} attempt ${n}: re-verifying the patched service`);
      verification = await observe(ctx, instance.base, path.join(ws, 'sut'), path.join(aDir, 'verification'), { phase: `${prId}.attempt-${n}.verify` });
    } finally {
      await instance.stop();
    }

    const remaining = verification.failures.filter((f) => f.kind === cluster.kind);
    const regressions = verification.failures.filter((f) => !baseKeys.has(qaAgent.keyOf(f)) && !UNROUTED.has(f.kind));
    const cleared = cluster.failures.filter((f) => !verification.failures.some((v) => qaAgent.keyOf(v) === qaAgent.keyOf(f)));
    const accepted = remaining.length === 0 && regressions.length === 0;
    ledger.append({
      agent: 'orchestrator', action: `${prId}.attempt-${n}.verdict`,
      summary: accepted ? `Verified: ${cleared.length} failure(s) cleared, no regressions` : `Not accepted: ${remaining.length} target failure(s) remain, ${regressions.length} regression(s)`,
      data: { remaining: remaining.map(qaAgent.keyOf), regressions: regressions.map(qaAgent.keyOf) },
      artefacts: [patchFile],
    });

    if (accepted) {
      attempts.push({ n, result: 'verified' });
      const perfBefore = Object.fromEntries(obs.perf.map((p) => [p.id, p.p95]));
      const perfAfter = Object.fromEntries(verification.perf.map((p) => [p.id, p.p95]));
      const pr = {
        id: prId,
        status: verdict.outcome === 'REFERENCE_CHECK_REQUIRED' ? 'awaiting-reference-check' : 'awaiting-review',
        kind: cluster.kind,
        title: cluster.title,
        risk: cluster.risk,
        rootCause: proposal.rootCause,
        summary: proposal.summary,
        policyOutcome: verdict.outcome,
        policyFlags: verdict.flags,
        checkIds: cluster.checkIds,
        cleared: cleared.map((f) => ({ checkId: f.checkId, key: f.key, detail: f.detail })),
        regressions: 0,
        attempts,
        perfBefore,
        perfAfter,
        model: llm.label(),
        files: files.map(({ path: p, changedLines, baseSha, content, before }) => ({ path: p, changedLines, baseSha, content, before })),
        patch: path.relative(ctx.runDir, patchFile),
        verificationDir: path.relative(ctx.runDir, path.join(aDir, 'verification')),
      };
      const prFile = U.writeJSON(path.join(prDir, 'pr.json'), pr);
      U.writeText(path.join(prDir, 'patch.diff'), fs.readFileSync(patchFile, 'utf8'));
      ledger.append({ agent: 'orchestrator', action: `${prId}.ready`, summary: `${pr.title}: ${pr.policyOutcome}`, artefacts: [prFile, patchFile] });
      return pr;
    }

    attempts.push({ n, result: 'failed-verification', detail: `${remaining.length} target failure(s) remain, ${regressions.length} regression(s)` });
    feedback = [
      ...remaining.slice(0, 15).map((f) => `Still failing: [${f.checkId}] ${f.detail}`),
      ...regressions.slice(0, 15).map((f) => `New failure introduced: [${f.checkId}] ${f.detail}`),
    ].join('\n');
  }

  return { id: prId, status: 'not-fixed', cluster, attempts };
}

async function integrate(prs, ctx) {
  const dir = path.join(ctx.runDir, 'integration');
  const ws = path.join(dir, 'workspace');
  fs.cpSync(ctx.sutDir, path.join(ws, 'sut'), { recursive: true });
  const conflicts = [];
  for (const pr of prs) {
    for (const f of pr.files) {
      const target = path.join(ws, f.path);
      const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      const merged = U.mergeFile(current, f.before, f.content, path.join(dir, '.merge-scratch'));
      if (!merged.ok) conflicts.push({ pr: pr.id, file: f.path, reason: merged.reason });
      else U.writeText(target, merged.content);
    }
  }
  if (conflicts.length) {
    const cFile = U.writeJSON(path.join(dir, 'conflicts.json'), conflicts);
    ctx.ledger.append({ agent: 'orchestrator', action: 'integration.conflict', summary: `${conflicts.length} conflict(s)`, artefacts: [cFile] });
    return { prs: prs.map((p) => p.id), conflicts, verified: false };
  }
  const instance = await U.startSut(path.join(ws, 'sut'), path.join(dir, 'sut.log'));
  let obs;
  try {
    obs = await observe(ctx, instance.base, path.join(ws, 'sut'), path.join(dir, 'verification'), { phase: 'integration.verify' });
  } finally {
    await instance.stop();
  }
  const outstanding = obs.failures.filter((f) => !UNROUTED.has(f.kind));
  const result = {
    prs: prs.map((p) => p.id),
    conflicts,
    verified: outstanding.length === 0,
    checks: obs.functional.length,
    passed: obs.functional.filter((r) => r.status === 'pass').length,
    perf: obs.perf.map((p) => ({ id: p.id, p95: p.p95, budget: p.budget })),
    outstanding: outstanding.map((f) => ({ checkId: f.checkId, kind: f.kind, detail: f.detail })),
    unrouted: obs.failures.filter((f) => UNROUTED.has(f.kind)).map((f) => ({ checkId: f.checkId, kind: f.kind, detail: f.detail })),
  };
  const rFile = U.writeJSON(path.join(dir, 'result.json'), result);
  ctx.ledger.append({ agent: 'orchestrator', action: 'integration.verdict', summary: result.verified ? `All ${prs.length} PRs together: every routed check passes` : `${outstanding.length} failure(s) remain with all PRs applied`, artefacts: [rFile] });
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = U.ROOT;
  const runsDir = path.join(root, 'runs');
  const id = U.shiftId();
  const runDir = path.join(runsDir, id);
  fs.mkdirSync(runDir, { recursive: true });

  const spec = U.readJSON(path.join(root, 'spec', 'acceptance-criteria.json'));
  const policy = U.readJSON(path.join(root, 'spec', 'policy.json'));
  const reference = U.readJSON(path.join(root, 'spec', 'reference', 'uk-bank-holidays-ew.json'));
  const ledger = new Ledger(path.join(runDir, 'ledger.jsonl'), runDir);
  const llm = new LLM({ maxCalls: policy.llm.maxCalls });
  const ctx = {
    root, runDir, spec, policy, ledger, llm,
    sutDir: path.join(root, 'sut'),
    oracle: makeOracle(reference, spec.cutoverTradeDate),
    openapi: fs.readFileSync(path.join(root, 'sut', 'openapi.json'), 'utf8'),
  };
  const fingerprint = () => ({ spec: U.hashTree(path.join(root, 'spec')), factory: U.hashTree(path.join(root, 'factory')), sut: U.hashTree(ctx.sutDir) });
  const integrityStart = fingerprint();
  const baseline = U.readJSON(path.join(runsDir, 'latest.json'), null);

  const shift = {
    id, label: args.label, startedAt: new Date().toISOString(), host: require('os').hostname(),
    model: llm.label(), fixEnabled: args.fix && llm.available, sutFingerprint: integrityStart.sut.slice(0, 12),
    baselineShift: baseline?.shiftId || null, halted: null, prs: [], tickets: [], riskFlags: [], routing: ROUTING,
    halt(reason, rule) {
      if (this.halted) return;
      this.halted = { reason, rule, at: new Date().toISOString() };
      ledger.append({ agent: 'policy-gate', action: 'shift.halt', summary: reason, data: { rule } });
      log(`HALT (${rule}): ${reason}`);
    },
  };

  log(`Night shift ${id} starting. Model: ${shift.model}. Fixing: ${shift.fixEnabled ? 'on' : 'off'}.`);
  ledger.append({ agent: 'orchestrator', action: 'shift.start', summary: `Shift ${id}`, data: { integrity: integrityStart, model: shift.model, baselineShift: shift.baselineShift, fixEnabled: shift.fixEnabled } });

  // 1. Observe
  log('Observe: Test, Performance and Security Agents running against the service');
  const main = await U.startSut(ctx.sutDir, path.join(runDir, 'logs', 'sut-main.log'));
  let obs;
  try {
    obs = await observe(ctx, main.base, ctx.sutDir, path.join(runDir, 'evidence'), {
      phase: 'observe', rerun: true, explore: args.explore, baselinePerf: baseline?.perfP95 || {},
    });
  } finally {
    await main.stop();
  }
  log(`  ${obs.failures.length} failure signal(s) across ${obs.functional.length} checks, ${obs.perf.length} NFRs, ${obs.security.length} security finding(s)`);

  // 2. Classify against last shift
  const qa = qaAgent.classify(obs.failures, baseline);
  const qaFile = U.writeJSON(path.join(runDir, 'evidence', 'qa.json'), qa);
  ledger.append({ agent: 'qa-agent', action: 'classify', summary: qa.hasBaseline ? `${qa.counts.new} new, ${qa.counts.known} known, ${qa.counts.fixed} fixed since ${qa.baselineShift}` : 'No previous shift: everything is new', artefacts: [qaFile] });

  // 3. Policy gate on findings
  for (const f of obs.failures) {
    if (f.kind === 'secret') shift.riskFlags.push({ severity: 'Critical', source: 'Security Agent', rule: 'POL-01', title: 'Live credential in source', detail: f.detail, outcome: 'BLOCK_RELEASE', action: 'Rotate the credential and load it from a vault. Not auto-fixed and never sent to a model.' });
    if (f.kind === 'flaky') shift.riskFlags.push({ severity: 'Medium', source: 'Test Agent', rule: '—', title: `Flaky check ${f.checkId}`, detail: f.detail, outcome: 'QUARANTINED', action: 'Human triage before trusting this check.' });
    if (f.kind === 'exploratory') shift.riskFlags.push({ severity: 'Low', source: 'Test Agent (AI probe)', rule: 'POL-07', title: `Exploratory probe ${f.checkId}`, detail: f.detail, outcome: 'HUMAN_TRIAGE', action: 'Decide whether the model\'s expectation or the service is wrong.' });
    if (f.kind === 'harness') shift.riskFlags.push({ severity: 'High', source: 'Test Agent', rule: '—', title: `Check ${f.checkId} could not run`, detail: f.detail, outcome: 'HUMAN_TRIAGE', action: 'Fix the harness or the environment.' });
  }

  // 4. Route
  const clusters = Object.keys(CLUSTERS)
    .map((kind) => ({ kind, ...CLUSTERS[kind], failures: obs.failures.filter((f) => f.kind === kind) }))
    .filter((c) => c.failures.length)
    .map((c) => ({ ...c, checkIds: [...new Set(c.failures.map((f) => f.checkId))] }));
  const routeFile = U.writeJSON(path.join(runDir, 'evidence', 'routing.json'), clusters.map(({ kind, title, route, checkIds, failures }) => ({ kind, title, route, checkIds, failures: failures.length })));
  ledger.append({ agent: 'orchestrator', action: 'route', summary: `${clusters.length} cluster(s) routed to the Fix Agent`, artefacts: [routeFile] });

  // 5. Fix
  let n = 0;
  for (const cluster of clusters) {
    if (shift.halted) {
      shift.tickets.push({ ...cluster, reason: 'Shift halted before this cluster was attempted' });
      continue;
    }
    if (!shift.fixEnabled) {
      shift.tickets.push({ ...cluster, reason: llm.available ? 'Fixing turned off for this shift (--no-fix)' : 'No model configured. Set ANTHROPIC_API_KEY or NSF_LLM=claude-cli to get proposed fixes.' });
      continue;
    }
    n += 1;
    const prId = `PR-${String(n).padStart(3, '0')}`;
    const result = await runFixCluster(cluster, prId, ctx, obs, shift);
    if (result.status === 'awaiting-review' || result.status === 'awaiting-reference-check') shift.prs.push(result);
    else shift.tickets.push({ ...cluster, prId, attempts: result.attempts, reason: result.status === 'halted' ? 'Patch discarded by the policy gate (POL-02)' : 'Fix Agent could not produce a verified fix' });
  }

  // 6. Integrate
  shift.integration = null;
  if (shift.prs.length && !shift.halted) {
    log(`Integrate: verifying all ${shift.prs.length} PR(s) applied together`);
    shift.integration = await integrate(shift.prs, ctx);
  }

  // 7. Integrity: nothing the agents rely on may change during a shift
  const integrityEnd = fingerprint();
  for (const k of ['spec', 'factory', 'sut']) {
    if (integrityEnd[k] !== integrityStart[k]) shift.halt(`${k}/ changed during the shift; results are not trusted`, 'POL-06');
  }
  const ledgerCheck = Ledger.verify(ledger.file, runDir);
  if (!ledgerCheck.ok) shift.halt(`Evidence ledger failed verification: ${ledgerCheck.errors[0]}`, 'POL-06');

  // 8. Release decision
  const secrets = obs.failures.filter((f) => f.kind === 'secret');
  let release;
  if (shift.halted) release = { state: 'HALTED', reason: shift.halted.reason };
  else if (secrets.length) {
    const rest = [
      shift.prs.length ? `${shift.prs.length} verified PR(s) wait for your review` : '',
      shift.tickets.length ? `${shift.tickets.length} defect cluster(s) have no verified fix` : '',
    ].filter(Boolean).join(', and ');
    release = { state: 'BLOCKED', reason: `A live credential is in the source (POL-01), so nothing ships until it is rotated.${rest ? ` Separately, ${rest}.` : ''}` };
  }
  else if (shift.tickets.length) release = { state: 'NOT READY', reason: `${shift.tickets.length} defect cluster(s) have no verified fix.` };
  else if (shift.prs.length) release = { state: 'AWAITING SIGN-OFF', reason: `${shift.prs.length} verified PR(s) need human review.` };
  else release = { state: 'GREEN', reason: 'Every check passed.' };

  shift.release = release;
  shift.endedAt = new Date().toISOString();
  shift.llmCalls = llm.calls;
  shift.qa = qa;
  shift.obs = obs;
  shift.clusters = clusters;
  shift.policyRules = policy.rules;
  shift.ledger = { entries: ledgerCheck.entries.length, head: ledgerCheck.head, ok: ledgerCheck.ok, errors: ledgerCheck.errors };
  shift.timeline = ledgerCheck.entries.map(({ seq, ts, agent, action, summary, model }) => ({ seq, ts, agent, action, summary, model }));

  const packFiles = writeMorningPack(shift, runDir);
  ledger.append({ agent: 'orchestrator', action: 'shift.end', summary: `${release.state}: ${release.reason}`, data: { prs: shift.prs.map((p) => p.id), llmCalls: llm.calls }, artefacts: packFiles });

  U.writeJSON(path.join(runsDir, 'latest.json'), {
    shiftId: id,
    endedAt: shift.endedAt,
    failureKeys: obs.failures.filter((f) => f.kind !== 'exploratory').map(qaAgent.keyOf),
    perfP95: Object.fromEntries(obs.perf.map((p) => [p.id, p.p95])),
  });

  log(`Shift ${id} finished: ${release.state}. ${shift.prs.length} PR(s), ${shift.riskFlags.length} risk flag(s).`);
  log(`Morning pack: ${path.relative(process.cwd(), packFiles[0])}`);
  return shift;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, observe, CLUSTERS, ROUTING };

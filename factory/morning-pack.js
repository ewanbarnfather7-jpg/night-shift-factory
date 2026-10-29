'use strict';
// Morning pack: what the human "editor-in-chief" reads at the start of the day.
// Writes morning-pack.html (self-contained), morning-pack.json and digest.md.

const path = require('path');
const { writeJSON, writeText } = require('./lib/util');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATE_TONE = { HALTED: 'stop', BLOCKED: 'stop', 'NOT READY': 'warn', 'AWAITING SIGN-OFF': 'review', GREEN: 'go' };
const STATE_SENTENCE = {
  HALTED: 'The shift was halted by the policy gate.',
  BLOCKED: 'Release is blocked.',
  'NOT READY': 'Not ready for release.',
  'AWAITING SIGN-OFF': 'Fixes are verified and waiting for your sign-off.',
  GREEN: 'Every check passed overnight.',
};

const AGENT_NAMES = {
  orchestrator: 'Orchestrator', 'test-agent': 'Test Agent', 'perf-agent': 'Performance Agent',
  'security-agent': 'Security Agent', 'qa-agent': 'QA Agent', 'fix-agent': 'Fix Agent', 'policy-gate': 'Policy gate',
};
const AGENT_LANES = ['test-agent', 'perf-agent', 'security-agent', 'qa-agent', 'fix-agent', 'policy-gate', 'orchestrator'];

const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/London' });
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
const minutes = (a, b) => Math.max(1, Math.round((new Date(b) - new Date(a)) / 60000));

function diffHtml(patch) {
  return patch.split('\n').map((line) => {
    const cls = /^(\+\+\+|---)/.test(line) ? 'file' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
    return `<span class="${cls}">${esc(line) || ' '}</span>`;
  }).join('');
}

function shiftStrip(shift) {
  const start = new Date(shift.startedAt).getTime();
  const end = Math.max(new Date(shift.endedAt).getTime(), start + 1000);
  const span = end - start;
  const lanes = AGENT_LANES.filter((a) => shift.timeline.some((e) => e.agent === a));
  const rows = lanes.map((agent) => {
    const ticks = shift.timeline.filter((e) => e.agent === agent).map((e) => {
      const x = (((new Date(e.ts).getTime() - start) / span) * 100).toFixed(2);
      const alert = /halt|BLOCK|Not accepted|No usable/.test(`${e.action} ${e.summary}`);
      return `<span class="tick${alert ? ' alert' : ''}" style="left:${x}%" title="${esc(`${fmtTime(e.ts)} ${e.action}: ${e.summary}`)}"></span>`;
    }).join('');
    return `<div class="lane"><span class="lane-name">${esc(AGENT_NAMES[agent] || agent)}</span><span class="lane-track">${ticks}</span></div>`;
  }).join('');
  return `<figure class="strip" aria-label="Agent activity across the shift">${rows}
    <figcaption><span>${fmtTime(shift.startedAt)}</span><span>${minutes(shift.startedAt, shift.endedAt)} min, ${shift.timeline.length} ledger entries</span><span>${fmtTime(shift.endedAt)}</span></figcaption></figure>`;
}

function prCard(pr, shift) {
  const refCheck = pr.policyOutcome === 'REFERENCE_CHECK_REQUIRED';
  const cmd = `node factory/signoff.js --shift ${shift.id} --pr ${pr.id} --approve --reviewer "Your name"${refCheck ? ' --reference-checked "Source you checked"' : ''}`;
  const perfRows = pr.kind !== 'perf' ? '' : Object.keys(pr.perfBefore || {}).map((k) => `<li>${esc(k)}: p95 ${pr.perfBefore[k]} ms before, ${pr.perfAfter[k]} ms after</li>`).join('');
  const lines = pr.files.reduce((n, f) => n + f.changedLines, 0);
  return `<details class="pr" ${shift.prs.length <= 3 ? 'open' : ''}>
    <summary>
      <span class="pr-id">${esc(pr.id)}</span>
      <span class="pr-title">${esc(pr.title)}</span>
      <span class="badge ${refCheck ? 'warn' : 'review'}">${refCheck ? 'Reference check required' : 'Ready for review'}</span>
    </summary>
    <div class="pr-body">
      <p class="lede">${esc(pr.summary)}</p>
      <dl class="facts">
        <dt>Root cause</dt><dd>${esc(pr.rootCause)}</dd>
        <dt>Clears</dt><dd>${pr.cleared.length} failure${pr.cleared.length === 1 ? '' : 's'} across ${esc(pr.checkIds.join(', '))}</dd>
        <dt>Regressions</dt><dd>None. The full suite, benchmarks and security probes were re-run on the patched service.</dd>
        <dt>Risk</dt><dd>${esc(pr.risk)}. ${pr.files.length} file${pr.files.length === 1 ? '' : 's'}, ${lines} changed line${lines === 1 ? '' : 's'}, ${pr.attempts.length} attempt${pr.attempts.length === 1 ? '' : 's'}.</dd>
        ${refCheck ? `<dt>Before approving</dt><dd>${esc(pr.policyFlags.map((f) => f.detail).join(' '))}</dd>` : ''}
        ${perfRows ? `<dt>Latency</dt><dd><ul class="plain">${perfRows}</ul></dd>` : ''}
      </dl>
      <details class="cleared"><summary>Failures this clears</summary><ul>${pr.cleared.map((c) => `<li><b>${esc(c.checkId)}</b> ${esc(c.detail)}</li>`).join('')}</ul></details>
      <pre class="diff" aria-label="Patch">${diffHtml(pr.patchText || '')}</pre>
      <p class="cmd-label">To approve, run in the project folder:</p>
      <pre class="cmd">${esc(cmd)}</pre>
    </div>
  </details>`;
}

function render(shift) {
  const tone = STATE_TONE[shift.release.state] || 'warn';
  const functional = shift.obs.functional;
  const passed = functional.filter((r) => r.status === 'pass').length;
  const sweep = functional.find((r) => r.type === 'sweep');
  const qa = shift.qa;

  const flags = shift.riskFlags.length ? `<table>
      <thead><tr><th>Severity</th><th>Finding</th><th>Policy</th><th>What to do</th></tr></thead>
      <tbody>${shift.riskFlags.map((f) => `<tr><td><span class="sev sev-${esc(f.severity.toLowerCase())}">${esc(f.severity)}</span></td><td><b>${esc(f.title)}</b><br><span class="muted">${esc(f.detail)}</span><br><span class="muted">${esc(f.source)}</span></td><td>${esc(f.rule)} ${esc(f.outcome.replace(/_/g, ' ').toLowerCase())}</td><td>${esc(f.action)}</td></tr>`).join('')}</tbody>
    </table>` : '<p class="muted">No risk flags raised.</p>';

  const tickets = shift.tickets.length ? `<h2>Defects without a verified fix</h2>
    <ul class="tickets">${shift.tickets.map((t) => `<li><b>${esc(t.title)}</b> (${t.failures.length} failure${t.failures.length === 1 ? '' : 's'} in ${esc(t.checkIds.join(', '))}). ${esc(t.reason)}.
      <ul>${t.failures.slice(0, 5).map((f) => `<li>${esc(f.detail)}</li>`).join('')}${t.failures.length > 5 ? `<li>and ${t.failures.length - 5} more</li>` : ''}</ul></li>`).join('')}</ul>` : '';

  const evidenceRows = functional.map((r) => `<tr class="${r.status}">
      <td>${esc(r.id)}</td><td>${esc(r.title)}</td>
      <td><span class="result ${r.status}">${r.status === 'pass' ? 'Pass' : r.status === 'flaky' ? 'Flaky' : 'Fail'}</span></td>
      <td class="muted">${r.failures.length ? esc(r.failures.slice(0, 3).map((f) => f.detail).join(' | ')) + (r.failures.length > 3 ? ` (+${r.failures.length - 3})` : '') : ''}</td></tr>`).join('');

  const perfRows = shift.obs.perf.map((p) => `<tr class="${p.status}"><td>${esc(p.id)}</td><td>${esc(`${p.method} ${p.path}`)}</td><td class="num">${p.p50}</td><td class="num">${p.p95}</td><td class="num">${p.budget}</td><td class="num">${p.previousP95 ?? 'none'}</td><td><span class="result ${p.status}">${p.status === 'pass' ? 'Within budget' : 'Over budget'}</span></td></tr>`).join('');

  const integration = shift.integration ? `<p>${shift.integration.conflicts.length
    ? `The PRs conflict when combined (${esc(shift.integration.conflicts.map((c) => `${c.pr} in ${c.file}`).join(', '))}). Review them in order.`
    : shift.integration.verified
      ? `All ${shift.integration.prs.length} PRs applied together pass ${shift.integration.passed} of ${shift.integration.checks} acceptance checks and every benchmark${shift.integration.unrouted.length ? `. What still fails is held for people, not the Fix Agent: ${esc(shift.integration.unrouted.map((u) => u.checkId).join(', '))}` : ''}.`
      : `With all PRs applied, ${shift.integration.outstanding.length} failure(s) remain.`}</p>` : '';

  const timelineRows = shift.timeline.map((e) => `<tr><td class="num">${fmtTime(e.ts)}</td><td>${esc(AGENT_NAMES[e.agent] || e.agent)}</td><td>${esc(e.summary)}${e.model ? `<br><span class="muted">${esc(e.model)}</span>` : ''}</td></tr>`).join('');

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Morning pack ${esc(shift.id)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
:root{
  --night:#16213A; --dusk:#2B3A63; --dawn:#E9B872; --paper:#F3F5F8; --surface:#FFFFFF; --ink:#18202E; --muted:#5B6578; --rule:#D9DEE7;
  --stop:#B42318; --stop-bg:#FDECEA; --warn:#9A5B00; --warn-bg:#FFF4E0; --review:#2D55C8; --review-bg:#E9EFFC; --go:#1E7148; --go-bg:#E6F4EC;
  --add:#E6F4EC; --del:#FDECEA;
  --sans:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',sans-serif; --mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --paper:#0F1626; --surface:#162036; --ink:#E6EAF2; --muted:#9AA5BA; --rule:#2A3654;
  --stop:#FF8A7A; --stop-bg:#3A1D22; --warn:#F2B860; --warn-bg:#3A2D14; --review:#93ADFF; --review-bg:#1E2A4F; --go:#7FD3A3; --go-bg:#16352A;
  --add:#16352A; --del:#3A1D22;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 var(--sans)}
.sky{background:linear-gradient(180deg,var(--night) 0%,var(--dusk) 78%,#6B5A6E 92%,var(--dawn) 100%);color:#EEF1F8;padding:40px 16px 0}
.wrap{max-width:920px;margin:0 auto}
.sky h1{font-weight:500;font-size:15px;letter-spacing:.01em;margin:0 0 6px;color:#C9D2E6}
.verdict{font-size:clamp(28px,5vw,44px);line-height:1.12;font-weight:600;margin:0 0 12px;max-width:22ch}
.reason{font-size:18px;color:#DCE2EF;max-width:62ch;margin:0 0 28px}
.strip{margin:0;padding:18px 18px 12px;background:rgba(8,12,24,.35);border-radius:10px 10px 0 0}
.lane{display:grid;grid-template-columns:150px 1fr;align-items:center;gap:12px;height:24px}
.lane-name{font-size:13px;color:#C9D2E6;white-space:nowrap}
.lane-track{position:relative;height:2px;background:rgba(255,255,255,.18)}
.tick{position:absolute;top:-6px;width:3px;height:14px;border-radius:2px;background:var(--dawn)}
.tick.alert{background:#FF8A7A;height:18px;top:-8px}
.strip figcaption{display:flex;justify-content:space-between;font-size:13px;color:#AEB8CF;margin-top:10px;padding-left:162px}
main{padding:8px 16px 64px}
section{margin-top:40px}
h2{font-size:22px;font-weight:600;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 16px;max-width:66ch}
.tone-stop .verdict{color:#FFD6CF}.tone-go .verdict{color:#CFF2DD}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));background:var(--surface);border:1px solid var(--rule);border-radius:10px;overflow:hidden;margin-top:-1px}
.kpis div{padding:14px 16px;box-shadow:0 0 0 .5px var(--rule)}
.kpis b{display:block;font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}
.kpis span{font-size:14px;color:var(--muted)}
.pr{background:var(--surface);border:1px solid var(--rule);border-radius:10px;margin-bottom:12px}
.pr>summary{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;padding:16px 18px;cursor:pointer;list-style:none}
.pr>summary::-webkit-details-marker{display:none}
.pr-id{font-family:var(--mono);font-size:14px;color:var(--muted)}
.pr-title{font-weight:600;font-size:18px;flex:1 1 280px}
.badge{font-size:13px;padding:2px 10px;border-radius:999px;white-space:nowrap}
.badge.review{background:var(--review-bg);color:var(--review)}.badge.warn{background:var(--warn-bg);color:var(--warn)}
.pr-body{padding:0 18px 18px;border-top:1px solid var(--rule)}
.lede{font-size:17px;margin:14px 0}
.facts{display:grid;grid-template-columns:140px 1fr;gap:6px 16px;margin:0 0 14px}
.facts dt{color:var(--muted);font-size:14px;padding-top:2px}.facts dd{margin:0}
.plain{margin:0;padding-left:18px}
.cleared summary{cursor:pointer;color:var(--review);font-size:14px;margin-bottom:6px}
.cleared ul{font-size:14px;color:var(--muted);margin:0 0 12px}
pre{font:13px/1.5 var(--mono);overflow-x:auto;border-radius:8px;margin:0}
.diff{background:var(--paper);border:1px solid var(--rule);padding:12px 0;max-height:420px}
.diff span{display:block;padding:0 14px;white-space:pre}
.diff .add{background:var(--add)}.diff .del{background:var(--del)}.diff .hunk{color:var(--review)}.diff .file{color:var(--muted)}
.cmd-label{font-size:14px;color:var(--muted);margin:14px 0 6px}
.cmd{background:var(--night);color:#E9EEF8;padding:12px 14px;white-space:pre-wrap;word-break:break-all}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--rule);border-radius:10px;overflow:hidden;font-size:14px}
th{text-align:left;font-weight:500;color:var(--muted);padding:10px 12px;border-bottom:1px solid var(--rule)}
td{padding:10px 12px;border-bottom:1px solid var(--rule);vertical-align:top}
tr:last-child td{border-bottom:0}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.muted{color:var(--muted)}
.result{font-size:13px;padding:1px 8px;border-radius:999px;white-space:nowrap}
.result.pass{background:var(--go-bg);color:var(--go)}.result.fail{background:var(--stop-bg);color:var(--stop)}.result.flaky{background:var(--warn-bg);color:var(--warn)}
.sev{font-size:13px;font-weight:500}
.sev-critical,.sev-high{color:var(--stop)}.sev-medium{color:var(--warn)}.sev-low{color:var(--muted)}
.tickets li{margin-bottom:10px}.tickets ul{color:var(--muted);font-size:14px}
.halt{background:var(--stop-bg);color:var(--stop);border-radius:10px;padding:14px 18px;margin-top:24px}
.scroll{overflow-x:auto}
.ledger{font-family:var(--mono);font-size:13px;word-break:break-all}
details.more>summary{cursor:pointer;color:var(--review)}
:focus-visible{outline:2px solid var(--review);outline-offset:2px}
@media (max-width:640px){.lane{grid-template-columns:112px 1fr}.lane-name{font-size:12px}.strip figcaption{padding-left:0}.facts{grid-template-columns:1fr}.facts dt{padding-top:8px}}
</style>
</head>
<body>
<header class="sky tone-${tone}">
  <div class="wrap">
    <h1>Overnight run, ${esc(fmtDate(shift.startedAt))}${shift.label ? ` (${esc(shift.label)})` : ''}</h1>
    <p class="verdict">${esc(STATE_SENTENCE[shift.release.state])}</p>
    <p class="reason">${esc(shift.release.reason)}</p>
    ${shiftStrip(shift)}
  </div>
</header>
<main class="wrap">
  <div class="kpis">
    <div><b>${passed}/${functional.length}</b><span>acceptance checks passed</span></div>
    <div><b>${sweep ? sweep.evidence.checked : 0}</b><span>trade dates swept against the oracle</span></div>
    <div><b>${shift.prs.length}</b><span>verified PRs to review</span></div>
    <div><b>${shift.riskFlags.length}</b><span>risk flags</span></div>
    <div><b>${qa.hasBaseline ? `${qa.counts.new} new, ${qa.counts.fixed} fixed` : 'First shift'}</b><span>${qa.hasBaseline ? `since ${esc(qa.baselineShift)}` : 'no baseline yet'}</span></div>
  </div>

  ${shift.halted ? `<div class="halt" role="alert"><b>Halted by ${esc(shift.halted.rule)}.</b> ${esc(shift.halted.reason)}</div>` : ''}

  <section>
    <h2>Your decisions</h2>
    <p class="sub">Each PR was written by the Fix Agent, passed the policy gate, and was verified on an isolated copy of the service against the factory's own tests. Nothing has been merged.</p>
    ${shift.prs.length ? shift.prs.map((pr) => prCard(pr, shift)).join('') : `<p class="muted">${shift.fixEnabled ? 'No PRs tonight.' : 'No PRs: fixing was not enabled for this shift.'}</p>`}
    ${integration}
  </section>

  <section>
    <h2>Risk flags</h2>
    <p class="sub">Findings the policy gate kept away from the Fix Agent.</p>
    <div class="scroll">${flags}</div>
  </section>

  ${tickets ? `<section>${tickets}</section>` : ''}

  <section>
    <h2>Test evidence</h2>
    <p class="sub">Expected results come from the acceptance criteria and an independent holiday calendar, not from the service. Failing checks were re-run once to separate real failures from flaky ones.</p>
    <div class="scroll"><table><thead><tr><th>Check</th><th>Criterion</th><th>Result</th><th>Detail</th></tr></thead><tbody>${evidenceRows}</tbody></table></div>
  </section>

  <section>
    <h2>Performance</h2>
    <p class="sub">Milliseconds. A breach is confirmed with a second run before it is routed.</p>
    <div class="scroll"><table><thead><tr><th>NFR</th><th>Endpoint</th><th>p50</th><th>p95</th><th>Budget</th><th>Last shift</th><th>Result</th></tr></thead><tbody>${perfRows}</tbody></table></div>
  </section>

  <section>
    <h2>How work was routed</h2>
    <div class="scroll"><table><thead><tr><th>When</th><th>Goes to</th></tr></thead><tbody>${shift.routing.map((r) => `<tr><td>${esc(r.when)}</td><td>${esc(r.to)}</td></tr>`).join('')}</tbody></table></div>
  </section>

  <section>
    <h2>Shift log</h2>
    <p class="sub">Every agent action, in order, from the evidence ledger. Model used: ${esc(shift.model)}, ${shift.llmCalls} call${shift.llmCalls === 1 ? '' : 's'}.</p>
    <details class="more"><summary>Show all ${shift.timeline.length} entries</summary>
      <div class="scroll"><table><thead><tr><th>Time</th><th>Agent</th><th>What happened</th></tr></thead><tbody>${timelineRows}</tbody></table></div>
    </details>
  </section>

  <section>
    <h2>Evidence integrity</h2>
    <p class="sub">The ledger is hash-chained and records the SHA-256 of every artefact. Check it any time with <code>node factory/verify-ledger.js ${esc(shift.id)}</code>.</p>
    <p>${shift.ledger.ok ? `Verified: ${shift.ledger.entries} entries, chain intact when this pack was written.` : `Verification failed: ${esc(shift.ledger.errors.join('; '))}`}</p>
    <p class="ledger muted">Shift ${esc(shift.id)}<br>Head ${esc(shift.ledger.head)}<br>Service fingerprint ${esc(shift.sutFingerprint)}</p>
  </section>
</main>
</body>
</html>
`;
}

function digest(shift) {
  const lines = [
    `*Night shift ${shift.id}: ${shift.release.state}*`,
    shift.release.reason,
    '',
    ...shift.prs.map((p) => `• ${p.id} ${p.title} (${p.policyOutcome === 'REFERENCE_CHECK_REQUIRED' ? 'reference check required' : 'ready for review'})`),
    ...shift.riskFlags.filter((f) => ['Critical', 'High'].includes(f.severity)).map((f) => `• ${f.severity}: ${f.title}`),
  ];
  return `${lines.join('\n')}\n`;
}

function writeMorningPack(shift, runDir) {
  const fs = require('fs');
  for (const pr of shift.prs) {
    pr.patchText = fs.readFileSync(path.join(runDir, pr.patch), 'utf8');
  }
  const json = JSON.parse(JSON.stringify(shift));
  for (const pr of json.prs) for (const f of pr.files) { delete f.content; delete f.before; }
  return [
    writeText(path.join(runDir, 'morning-pack.html'), render(shift)),
    writeJSON(path.join(runDir, 'morning-pack.json'), json),
    writeText(path.join(runDir, 'digest.md'), digest(shift)),
  ];
}

module.exports = { writeMorningPack, render };

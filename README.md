# Night Shift Factory

An overnight, multi-agent test factory for a UK T+1 settlement service, built from the McKinsey "agent factory" model described in [QA Financial, 30 April 2026](https://qa-financial.com/ai-agents-take-the-night-shift-banks-rethink-testing-in-software-factory-model/).

Agents test, benchmark, scan and fix overnight. An orchestrator routes their work. A policy gate decides what is allowed. Every action goes into a hash-chained evidence ledger. In the morning a person reviews a single pack and signs off. Nothing merges on its own.

Plain Node.js (20+), CommonJS, no dependencies, no `npm install`.

## How it maps to the article

| Article | Here |
|---|---|
| Test agents generate and run suites | **Test Agent** (`factory/agents/test-agent.js`): runs the acceptance criteria from `spec/`, sweeps every 2027–28 trade date against an independent oracle, and (with a model) proposes exploratory probes |
| QA agents identify regressions | **QA Agent**: compares with the last shift (new, known, fixed); failing checks are re-run once and quarantined if flaky |
| Security agents scan for vulnerabilities or leaked secrets | **Security Agent**: secret scan of the source plus probes against the contract (stack-trace leaks, request size limit) |
| Performance agents benchmark critical paths | **Performance Agent**: p95 against NFR budgets and the last shift; breaches are confirmed with a second run before routing |
| If tests fail, route back to a fix agent | **Fix Agent**: one patch per root-cause cluster, applied to an isolated copy and re-verified with the full suite |
| If performance declines, invoke a performance-checking agent | Confirmation benchmark, then the Fix Agent; the PR shows p95 before and after |
| If a policy is violated, halt the workflow | **Policy gate** (`spec/policy.json`): touching tests, spec, oracle, policy or config halts the shift |
| Evidence provenance | **Evidence ledger**: every agent action, model, prompt, response and artefact hash, chained so any edit is detectable |
| PRs, test evidence and risk flags by morning | **Morning pack** (`runs/<shift>/morning-pack.html`) plus a Slack-ready `digest.md` |
| Humans as editors-in-chief | `factory/signoff.js`: the only way a change reaches the service, recorded in the ledger |
| Unambiguous acceptance criteria and system context | `spec/acceptance-criteria.json` (from the T+1 Test Scenario Pack) and `sut/openapi.json` with NFRs |

## Quick start

```bash
# Observe only: find and report, no fixes
node factory/orchestrator.js --no-fix

# Full shift with Claude proposing fixes
export ANTHROPIC_API_KEY=sk-ant-...
node factory/orchestrator.js --label "Monday night"

# Open the result
open runs/$(node -p 'require("./runs/latest.json").shiftId')/morning-pack.html
```

A first shift takes about two minutes, most of it spent on the deliberately slow service; once the performance fix is in, a shift takes well under a minute.

### Choosing the model

| Setting | What happens |
|---|---|
| `ANTHROPIC_API_KEY` set | Claude API, model `claude-sonnet-5-5` (change with `NSF_MODEL`) |
| `NSF_LLM=claude-cli` | Uses your Claude Code login via `claude -p`, run in an empty temp folder. Experimental. |
| Neither | Agents still test, benchmark and scan; defects are reported as tickets with no proposed fix |

Secrets found by the Security Agent are redacted from every prompt. A shift is capped at 20 model calls (`spec/policy.json`).

## The morning

1. Open the morning pack. The top line is the release decision: Halted, Blocked, Not ready, Awaiting sign-off, or Green.
2. Review each PR: root cause, the failures it clears, the diff, and proof of no regressions.
3. Approve or reject:

```bash
node factory/signoff.js --shift latest --pr PR-002 --approve --reviewer "Ewan"
node factory/signoff.js --shift latest --pr PR-001 --approve --reviewer "Ewan" --reference-checked "gov.uk bank holidays, checked 27/10"
node factory/signoff.js --shift latest --pr PR-004 --reject --reviewer "Ewan" --note "Fix the cause, not the symptom"
```

Sign-off refuses to run if the ledger fails verification, if the files changed since the PR was verified, or if a reference-data change has no `--reference-checked`. The next shift confirms the fixes and reports them as fixed.

Check a ledger at any time: `node factory/verify-ledger.js latest`.

## Running it overnight

macOS (launchd), every weeknight at 01:07:

```bash
cp scripts/com.nightshift.factory.plist ~/Library/LaunchAgents/
# replace YOUR_USER and the node path (`which node`) in the file, then:
launchctl load ~/Library/LaunchAgents/com.nightshift.factory.plist
```

The Mac has to be awake. Or use cron: `7 1 * * 1-5 cd /path/to/night-shift-factory && node factory/orchestrator.js >> runs/cron.log 2>&1`

## The demo service and its seeded defects

`sut/` is a mock T+1 settlement service (trade capture, allocation, settlement instruction, settlement-date derivation). It ships with six realistic defects so the first shift has something to find. Keep this list to yourself if you are running it as a live demo.

| Defect | Found by | Policy outcome |
|---|---|---|
| 2027 calendar missing the Summer bank holiday (30 Aug) | Oracle sweep and RD-05 coverage control; no hand-written case covers it | PR, reference check required |
| First T+1 trade date (11 Oct 2027) treated as T+2 | CO-02 and the sweep | PR |
| Allocation at 00:30 on T+1 accepted (time compared without the date) | TL-03, TL-03B | PR |
| Date validation enumerates 25,000 dates on every request (~27 ms) | Performance Agent, both endpoints | PR |
| Malformed JSON returns a stack trace; no request size limit | Security Agent probes | PR |
| Live CREST gateway key in `sut/config.js` | Security Agent secret scan | Release blocked, human rotates; never auto-fixed |

To reset the demo after approving fixes, restore `sut/` from git or from a copy.

## Guardrails worth pointing at

- **The tests are not the Fix Agent's to change.** Verification always uses the factory's own spec, oracle and checks. A patch that touches them halts the shift (see `test/shift.test.js`, "a cheating fix halts the shift").
- **The oracle is independent.** Expected settlement dates come from `spec/reference/`, never from the service.
- **AI-generated expectations are not trusted.** Exploratory probes go to human triage, not to the Fix Agent.
- **Every fix is checked alone and together.** Each PR is verified on its own copy, then all PRs are merged and verified as one candidate.
- **Integrity is checked at the end.** If `spec/`, `factory/` or `sut/` changed during the shift, or the ledger fails verification, the shift is halted.

## Layout

```
sut/                 the service under test (+ openapi.json contract)
spec/                acceptance criteria, NFRs, policy, reference calendar (protected)
factory/
  orchestrator.js    the shift
  agents/            test, qa, security, perf, fix
  lib/               ledger, policy gate, oracle, model access, utilities
  morning-pack.js    the report
  signoff.js         human approval or rejection
  verify-ledger.js
test/                unit tests; e2e shift test with a scripted test double
runs/<shift>/        evidence, prompts and responses, PR workspaces, ledger, morning pack
```

## Tests

```bash
npm test            # unit: ledger tamper detection, policy gate, oracle, secret redaction
npm run test:e2e    # two full shifts on a temp copy, ~3 minutes
```

The e2e tests use `test/fixtures/scripted-llm.js`, a scripted stand-in for the model that returns fixed patches. It exists to test the factory's plumbing, not to demo AI.

## Limits

- The service is a mock. Matching, CSD interaction, funding and corporate actions from the scenario pack are not modelled.
- Latency budgets are tuned for a laptop; set real NFRs in `spec/acceptance-criteria.json`.
- PRs are patch files plus verification evidence, not GitHub pull requests. Wiring the sign-off step to a real repo is the natural next step.
- Holiday data is England & Wales 2027–28 and must be re-verified against the published CREST settlement calendar.

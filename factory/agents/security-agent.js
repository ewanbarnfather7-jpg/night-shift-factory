'use strict';
// Security Agent: static secret scan of the source tree plus dynamic probes
// against the running service.

const fs = require('fs');
const path = require('path');
const { listFiles, call } = require('../lib/util');

const SECRET_PATTERNS = [
  { name: 'Live API key prefix', re: /\b(?:sk|rk|pk|crst|api)_live_[A-Za-z0-9]{16,}\b/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Hard-coded credential', re: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"\s]{16,}['"]/i },
];

function entropy(s) {
  const counts = {};
  for (const ch of s) counts[ch] = (counts[ch] || 0) + 1;
  return Object.values(counts).reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0);
}

const mask = (s) => (s.length <= 10 ? '****' : `${s.slice(0, 6)}…${s.slice(-2)} (${s.length} chars)`);

function scanSecrets(sutDir, relPrefix = 'sut') {
  const findings = [];
  for (const rel of listFiles(sutDir)) {
    if (!/\.(js|json|ts|env|ya?ml)$/.test(rel) && !rel.endsWith('.env')) continue;
    const lines = fs.readFileSync(path.join(sutDir, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const hit = SECRET_PATTERNS.find((p) => p.re.test(line));
      const quoted = [...line.matchAll(/['"]([A-Za-z0-9_\-+/=]{24,})['"]/g)].map((m) => m[1]).find((s) => entropy(s) > 4.2);
      if (!hit && !quoted) return;
      const value = (hit && line.match(hit.re)[0]) || quoted;
      findings.push({
        id: 'SEC-SECRET', kind: 'secret', severity: 'critical',
        key: `${relPrefix}/${rel}:${i + 1}`,
        location: `${relPrefix}/${rel}:${i + 1}`,
        title: hit ? hit.name : 'High-entropy string',
        detail: `${hit ? hit.name : 'High-entropy string'} in ${relPrefix}/${rel} line ${i + 1}: ${mask(value.replace(/^.*?['"]|['"]$/g, ''))}`,
      });
    });
  }
  return findings;
}

async function probe(base) {
  const findings = [];

  // Malformed JSON must give a clean 400 with no stack trace or file paths.
  const malformed = await call(base, 'POST', '/trades', '{"isin": "GB0002634946", "side": ', { raw: true });
  const leaks = /\bat .+\.js:\d+|\/[\w.-]+\/[\w.-]+\.js/.test(malformed.text) || /"stack"/.test(malformed.text);
  if (malformed.status !== 400 || leaks) {
    findings.push({
      id: 'SEC-STACK', kind: 'security', severity: 'high', key: 'SEC-STACK',
      title: 'Error response leaks internals',
      detail: `Malformed JSON returned HTTP ${malformed.status}${leaks ? ' with a stack trace and server file paths' : ''}; expected a clean 400.`,
      evidence: { status: malformed.status, body: malformed.text.slice(0, 400) },
    });
  }

  // Oversized bodies must be refused (contract: maxRequestBodyBytes 1 MiB).
  const big = JSON.stringify({ isin: 'GB0002634946', padding: 'x'.repeat(2 * 1024 * 1024) });
  const oversized = await call(base, 'POST', '/trades', big, { raw: true, timeoutMs: 15000 });
  const refused = oversized.status === 413 || oversized.status === 0;
  if (!refused) {
    findings.push({
      id: 'SEC-BODYLIMIT', kind: 'security', severity: 'medium', key: 'SEC-BODYLIMIT',
      title: 'No request size limit',
      detail: `A 2 MiB request body was read in full and answered with HTTP ${oversized.status}; the contract limit is 1 MiB (expected 413).`,
      evidence: { status: oversized.status },
    });
  }
  return findings;
}

// Remove secrets from text before it is sent to a model (policy: redactSecretsBeforeSending).
function redact(text) {
  return text
    .split('\n')
    .map((line) => {
      const flagged = SECRET_PATTERNS.some((p) => p.re.test(line));
      return line.replace(/(['"])([^'"\s]{16,})\1/g, (all, q, s) => {
        const secretLike = (flagged && !/^https?:/.test(s)) || (/^[A-Za-z0-9_\-+/=]{24,}$/.test(s) && entropy(s) > 4.2);
        return secretLike ? `${q}[REDACTED]${q}` : all;
      });
    })
    .join('\n');
}

module.exports = { scanSecrets, probe, mask, redact };

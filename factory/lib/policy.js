'use strict';
// Policy gate. Evaluates every proposed patch before it is applied anywhere.

const path = require('path');

function normalise(p) {
  return path.posix.normalize(String(p).replace(/\\/g, '/')).replace(/^\.\//, '');
}

/**
 * files: [{ path, changedLines }]
 * Returns { outcome, violations, flags }
 *   outcome: HALT_SHIFT | REJECT_PATCH | REFERENCE_CHECK_REQUIRED | READY_FOR_REVIEW
 */
function evaluatePatch(files, policy) {
  const rules = policy.fixAgent;
  const violations = [];
  const flags = [];

  if (!files.length) violations.push({ rule: 'POL-04', severity: 'reject', detail: 'Patch changes no files' });
  if (files.length > rules.maxFilesPerPR) {
    violations.push({ rule: 'POL-04', severity: 'reject', detail: `Patch changes ${files.length} files (limit ${rules.maxFilesPerPR})` });
  }
  const totalLines = files.reduce((n, f) => n + (f.changedLines || 0), 0);
  if (totalLines > rules.maxChangedLines) {
    violations.push({ rule: 'POL-04', severity: 'reject', detail: `Patch changes ${totalLines} lines (limit ${rules.maxChangedLines})` });
  }

  for (const f of files) {
    const p = normalise(f.path);
    if (p.startsWith('..') || path.posix.isAbsolute(p)) {
      violations.push({ rule: 'POL-02', severity: 'halt', detail: `Path escapes the project: ${f.path}` });
    } else if (rules.protectedPaths.some((pp) => p === pp || p.startsWith(pp))) {
      violations.push({ rule: 'POL-02', severity: 'halt', detail: `Protected path: ${p}` });
    } else if (!rules.allowedPaths.some((ap) => p === ap || p.startsWith(ap))) {
      violations.push({ rule: 'POL-04', severity: 'reject', detail: `Outside allowed paths: ${p}` });
    }
    if (policy.referenceData.paths.includes(p)) {
      flags.push({ rule: 'POL-03', detail: policy.referenceData.reason });
    }
  }

  let outcome = 'READY_FOR_REVIEW';
  if (violations.some((v) => v.severity === 'halt')) outcome = 'HALT_SHIFT';
  else if (violations.length) outcome = 'REJECT_PATCH';
  else if (flags.length) outcome = 'REFERENCE_CHECK_REQUIRED';
  return { outcome, violations, flags, totalLines };
}

module.exports = { evaluatePatch, normalise };

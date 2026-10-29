'use strict';
// Evidence ledger: append-only, hash-chained JSON lines.
// Each entry records which agent did what, with which model, and the SHA-256
// of every artefact it produced. Changing any entry or any artefact after the
// fact breaks verification.

const fs = require('fs');
const path = require('path');
const { sha256, canonical } = require('./util');

class Ledger {
  constructor(file, runDir) {
    this.file = file;
    this.runDir = runDir;
    this.seq = 0;
    this.prev = 'GENESIS';
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length) {
        const last = JSON.parse(lines[lines.length - 1]);
        this.seq = last.seq;
        this.prev = last.hash;
      }
    }
  }

  append({ agent, action, summary, model = null, data = null, artefacts = [] }) {
    const entry = {
      seq: this.seq + 1,
      ts: new Date().toISOString(),
      agent,
      action,
      summary: summary || '',
      model,
      data,
      artefacts: artefacts.filter(Boolean).map((p) => ({
        path: path.relative(this.runDir, p).split(path.sep).join('/'),
        sha256: sha256(fs.readFileSync(p)),
      })),
      prevHash: this.prev,
    };
    entry.hash = sha256(canonical(entry));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    this.seq = entry.seq;
    this.prev = entry.hash;
    return entry;
  }

  static verify(file, runDir) {
    const errors = [];
    if (!fs.existsSync(file)) return { ok: false, entries: [], head: null, errors: ['ledger file missing'] };
    const entries = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let prev = 'GENESIS';
    entries.forEach((entry, i) => {
      const { hash, ...rest } = entry;
      if (entry.seq !== i + 1) errors.push(`entry ${i + 1}: sequence gap (found ${entry.seq})`);
      if (entry.prevHash !== prev) errors.push(`entry ${entry.seq}: chain broken (prevHash does not match)`);
      if (sha256(canonical(rest)) !== hash) errors.push(`entry ${entry.seq}: contents altered (hash mismatch)`);
      for (const a of entry.artefacts || []) {
        const full = path.join(runDir, a.path);
        if (!fs.existsSync(full)) errors.push(`entry ${entry.seq}: artefact missing ${a.path}`);
        else if (sha256(fs.readFileSync(full)) !== a.sha256) errors.push(`entry ${entry.seq}: artefact altered ${a.path}`);
      }
      prev = hash;
    });
    return { ok: errors.length === 0, entries, head: prev, errors };
  }
}

module.exports = { Ledger };

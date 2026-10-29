'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Deterministic JSON (sorted keys) so hashes are stable.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listFiles(full, base);
    return [path.relative(base, full).split(path.sep).join('/')];
  }).sort();
}

// One hash for a whole directory tree: used to fingerprint the SUT and to
// prove that spec, oracle, policy and factory did not change during a shift.
function hashTree(dir) {
  const parts = listFiles(dir).map((rel) => `${rel}:${sha256(fs.readFileSync(path.join(dir, rel)))}`);
  return sha256(parts.join('\n'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(base, method, urlPath, body, { raw = false, timeoutMs = 10000 } = {}) {
  const started = performance.now();
  const init = { method, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = raw ? body : JSON.stringify(body);
  }
  try {
    const res = await fetch(base + urlPath, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, ms: performance.now() - started };
  } catch (err) {
    return { status: 0, json: null, text: '', error: err.cause?.code || err.name || String(err), ms: performance.now() - started };
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startSut(sutDir, logFile) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(sutDir, 'server.js'), '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const stop = () => new Promise((resolve) => {
    if (logFile) writeText(logFile, log);
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) break;
    const res = await call(base, 'GET', '/health', undefined, { timeoutMs: 1000 });
    if (res.status === 200) return { base, port, stop, child };
    await sleep(100);
  }
  await stop();
  throw new Error(`Service in ${sutDir} did not start:\n${log.slice(-2000)}`);
}

// Unified diff between two strings, using the system `diff`.
function unifiedDiff(relPath, before, after, scratchDir) {
  fs.mkdirSync(scratchDir, { recursive: true });
  const a = path.join(scratchDir, 'a.tmp');
  const b = path.join(scratchDir, 'b.tmp');
  fs.writeFileSync(a, before);
  fs.writeFileSync(b, after);
  const res = spawnSync('diff', ['-u', '--label', `a/${relPath}`, '--label', `b/${relPath}`, a, b], { encoding: 'utf8' });
  fs.rmSync(a, { force: true });
  fs.rmSync(b, { force: true });
  if (res.error) return { patch: '', changedLines: Math.abs(after.split('\n').length - before.split('\n').length) };
  const patch = res.stdout || '';
  const changedLines = patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).length;
  return { patch, changedLines };
}

// Three-way merge of one file, using `git merge-file` when available.
function mergeFile(current, base, theirs, scratchDir) {
  if (current === base) return { ok: true, content: theirs };
  if (theirs === base || theirs === current) return { ok: true, content: current };
  fs.mkdirSync(scratchDir, { recursive: true });
  const [c, b, t] = ['current', 'base', 'theirs'].map((n) => path.join(scratchDir, `${n}.tmp`));
  fs.writeFileSync(c, current);
  fs.writeFileSync(b, base);
  fs.writeFileSync(t, theirs);
  const res = spawnSync('git', ['merge-file', '-p', c, b, t], { encoding: 'utf8' });
  if (res.error) return { ok: false, content: current, reason: 'git not available for 3-way merge' };
  return res.status === 0 ? { ok: true, content: res.stdout } : { ok: false, content: current, reason: 'overlapping changes' };
}

function shiftId(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `shift-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// Run async tasks with a small concurrency limit.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = {
  ROOT, sha256, canonical, writeJSON, writeText, readJSON, listFiles, hashTree, sleep,
  call, freePort, startSut, unifiedDiff, mergeFile, shiftId, pool,
};

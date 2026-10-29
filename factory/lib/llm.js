'use strict';
// Model access for the agents. Providers:
//   anthropic       - Claude API (set ANTHROPIC_API_KEY; picked automatically)
//   claude-cli      - your local Claude Code login (NSF_LLM=claude-cli), run in an empty temp dir
//   script:<file>   - a JS module (system, prompt, meta) => text; used for CI test doubles
//   none            - no model; agents still observe and report, but no fixes are proposed

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

class LLM {
  constructor({ maxCalls = 20 } = {}) {
    this.provider = process.env.NSF_LLM || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'none');
    this.model = process.env.NSF_MODEL || 'claude-sonnet-5-5';
    this.maxCalls = maxCalls;
    this.calls = 0;
  }

  get available() {
    return this.provider !== 'none';
  }

  label() {
    if (this.provider === 'anthropic') return `anthropic:${this.model}`;
    if (this.provider.startsWith('script:')) return `test-double:${path.basename(this.provider.slice(7))}`;
    return this.provider;
  }

  async complete(system, prompt, { maxTokens = 16000, meta = {} } = {}) {
    if (!this.available) throw new Error('NO_MODEL_CONFIGURED');
    if (this.calls >= this.maxCalls) throw new Error('LLM_BUDGET_EXHAUSTED');
    this.calls += 1;

    if (this.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(300000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Claude API ${res.status}: ${data.error?.message || 'request failed'}`);
      return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    }

    if (this.provider === 'claude-cli') {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nsf-llm-'));
      return new Promise((resolve, reject) => {
        const child = spawn('claude', ['-p', '--output-format', 'text'], { cwd });
        let out = '';
        let err = '';
        const timer = setTimeout(() => child.kill(), 300000);
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
          clearTimeout(timer);
          fs.rmSync(cwd, { recursive: true, force: true });
          if (code === 0) resolve(out);
          else reject(new Error(`claude CLI exited ${code}: ${err.slice(-500)}`));
        });
        child.stdin.end(`${system}\n\n${prompt}`);
      });
    }

    if (this.provider.startsWith('script:')) {
      const fn = require(path.resolve(this.provider.slice(7)));
      return fn(system, prompt, { ...meta, call: this.calls });
    }

    throw new Error(`Unknown NSF_LLM provider "${this.provider}"`);
  }
}

// Pull the first JSON object out of a model response.
function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(candidate);
}

module.exports = { LLM, extractJSON };

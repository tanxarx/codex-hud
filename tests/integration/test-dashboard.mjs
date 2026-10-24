import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RolloutParser } from '../../dist/collectors/rollout.js';
import { renderHud } from '../../dist/render/header.js';
import { stripAnsi } from '../../dist/render/colors.js';

test('dashboard reports observed cache use, optional expiry estimates and real usage windows without refreshing on duplicate telemetry', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-dashboard-'));
  const originalTtl = process.env.CODEX_HUD_CACHE_TTL_SECONDS;
  const now = Date.parse('2026-10-24T09:02:00Z');
  t.mock.method(Date, 'now', () => now);
  const file = path.join(root, 'rollout.jsonl');
  const info = {
    last_token_usage: { input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 100, total_tokens: 10100 },
    total_token_usage: { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 1000, total_tokens: 101000 },
    model_context_window: 128000,
  };
  const limits = { primary: { used_percent: 20, window_minutes: 300, resets_at: now / 1000 + 3600 },
    secondary: { used_percent: 7, window_minutes: 10080, resets_at: now / 1000 + 86400 } };
  const record = (timestamp, payload) => JSON.stringify({ timestamp, type: 'event_msg', payload }) + '\n';
  try {
    fs.writeFileSync(file, record('2026-10-24T09:00:00Z', { type: 'token_count', info, rate_limits: limits }));
    const parser = new RolloutParser();
    parser.setRolloutPath(file);
    let parsed = await parser.parse();
    assert.equal(parsed.tokenUsage.observedAt.toISOString(), '2026-10-24T09:00:00.000Z');
    fs.appendFileSync(file, record('2026-10-24T09:01:00Z', { type: 'token_count', info }));
    parsed = await parser.parse();
    assert.equal(parsed.tokenUsage.observedAt.toISOString(), '2026-10-24T09:00:00.000Z');
    assert.deepEqual(parsed.rateLimits, limits, 'unrelated updates retain the latest quota snapshot');
    const data = { config: { model: 'gpt-6.1-sol' }, git: { isGitRepo: false },
      project: { projectName: 'example', cwd: root }, sessionStart: new Date(now),
      tokenUsage: parsed.tokenUsage, rateLimits: parsed.rateLimits,
      memory: { usedBytes: 16 * 2 ** 30, totalBytes: 64 * 2 ** 30 } };
    const lines = () => renderHud(data, { width: 180, showDetails: true,
      layout: { mode: 'claude', showDuration: true, barWidth: 10 } }).map(stripAnsi);
    delete process.env.CODEX_HUD_CACHE_TTL_SECONDS;
    let output = lines().join('\n');
    assert.match(output, /Cache: 8\.0K read \(80% hit\).*last hit 2m0s ago.*expiry not reported/);
    assert.match(output, /Usage: 5h .*20%.*resets in 1h0m.*7d .*7%/);
    assert.match(output, /Approx RAM: .*16\.0 \/ 64 GB \(25%\)/);
    assert.match(output, /Tokens: 101\.0K/, 'dashboard totals are cumulative');
    process.env.CODEX_HUD_CACHE_TTL_SECONDS = '300';
    output = lines().join('\n');
    assert.match(output, /~expiry .*\(3m0s, 5m0s estimate\)/);
    t.mock.method(Date, 'now', () => now + 10 * 60 * 1000);
    assert.match(lines().join('\n'), /expiry estimate elapsed \(5m0s assumption\)/);
    assert.doesNotMatch(lines().join('\n'), /cache expired/i);
    process.env.CODEX_HUD_CACHE_TTL_SECONDS = 'invalid';
    assert.match(lines().join('\n'), /expiry not reported/);
    // Changing to a fresh response advances the observed time; changing the root clears it.
    fs.appendFileSync(file, record('2026-10-24T09:02:00Z', { type: 'token_count', info: {
      ...info, total_token_usage: { ...info.total_token_usage, total_tokens: 102000 },
    } }));
    assert.equal((await parser.parse()).tokenUsage.observedAt.toISOString(), '2026-10-24T09:02:00.000Z');
    const empty = path.join(root, 'other.jsonl');
    fs.writeFileSync(empty, '');
    parser.setRolloutPath(empty);
    parsed = await parser.parse();
    assert.equal(parsed.tokenUsage, null);
    assert.equal(parsed.rateLimits, null);
  } finally {
    t.mock.restoreAll();
    if (originalTtl === undefined) delete process.env.CODEX_HUD_CACHE_TTL_SECONDS;
    else process.env.CODEX_HUD_CACHE_TTL_SECONDS = originalTtl;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

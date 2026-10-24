import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('agent-link launcher preserves resume/fork, directory and prompt arguments and fails before launch on setup errors', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-link-')));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const launcher = path.join(bin, 'codex-hud-link');
  fs.copyFileSync(new URL('../../bin/codex-hud-link', import.meta.url), launcher);
  const log = path.join(root, 'calls.jsonl');
  const nodeScript = (file, body) => fs.writeFileSync(file,
    `#!${process.execPath}\nimport fs from 'node:fs';\n${body}`, { mode: 0o755 });
  nodeScript(path.join(bin, 'codex'), `fs.appendFileSync(process.env.CALL_LOG,
    JSON.stringify({ daemon: process.argv.slice(2) }) + '\\n');`);
  nodeScript(path.join(bin, 'codex-hud'), `console.log(JSON.stringify({
    args: process.argv.slice(2), style: process.env.CODEX_HUD_STYLE,
    updates: process.env.CODEX_HUD_UPDATE_CHECK }));`);
  const cli = path.join(root, 'agent-link.mjs');
  nodeScript(cli, `if (process.env.FAIL_ENSURE) process.exit(17);
    console.log(process.env.PROXY);`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log,
    AGENT_LINK_CLI_PATH: cli, AGENT_LINK_NODE: process.execPath,
    CODEX_HUD_STYLE: '', CODEX_HUD_UPDATE_CHECK: '', PROXY: '/tmp/agent-link fixture.sock' };
  const run = args => spawnSync('/bin/bash', [launcher, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    for (const subcommand of [[], ['resume', '--last'], ['fork', '11111111-1111-7111-8111-111111111111']]) {
      const result = run(subcommand);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      const [sub, ...rest] = subcommand;
      assert.deepEqual(output.args, [...(sub ? [sub] : []), '--remote', `unix://${env.PROXY}`, '-C', root, ...rest]);
      assert.equal(output.style, 'claude');
      assert.equal(output.updates, '0');
    }
    const prompt = 'keep quotes: \' " $(literal)';
    const explicit = run(['--cd', 'folder with spaces', '--', prompt]);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.deepEqual(JSON.parse(explicit.stdout).args,
      ['--remote', `unix://${env.PROXY}`, '--cd', 'folder with spaces', '--', prompt]);
    const before = fs.readFileSync(log, 'utf8');
    assert.ok(before.trim().split('\n').every(line =>
      JSON.stringify(JSON.parse(line).daemon) === JSON.stringify(['app-server', 'daemon', 'start'])));
    assert.equal(run(['--no-daemon']).status, 1);
    assert.equal(fs.readFileSync(log, 'utf8'), before, 'conflicting flags must not start a daemon');
    env.FAIL_ENSURE = '1';
    assert.equal(run([]).status, 17);
    delete env.FAIL_ENSURE;
    env.PROXY = '/tmp/one.sock\n/tmp/two.sock';
    const invalid = run([]);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '', 'invalid setup output must never launch a TUI');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

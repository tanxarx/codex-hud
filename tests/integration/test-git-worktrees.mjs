import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectGitStatus } from '../../dist/collectors/git.js';
import { renderProjectLine } from '../../dist/render/lines/project-line.js';
import { stripAnsi } from '../../dist/render/colors.js';

test('real worktrees retain their own branch and identify the GitHub repo through symlinked subfolders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-git-'));
  const main = path.join(root, 'main repo');
  const linked = path.join(root, 'review worktree');
  const git = (...args) => execFileSync('git', ['-C', main, ...args], { stdio: 'pipe' });
  try {
    fs.mkdirSync(main);
    git('init', '-b', 'main');
    git('-c', 'user.name=HUD Test', '-c', 'user.email=hud@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
    git('remote', 'add', 'origin', 'git@github.com:example/project.git');
    git('worktree', 'add', '-b', 'feature/hud', linked);
    const subdir = path.join(linked, 'nested folder');
    fs.mkdirSync(subdir);
    const alias = path.join(root, 'linked alias');
    fs.symlinkSync(subdir, alias);
    const status = collectGitStatus(alias);
    assert.equal(status.branch, 'feature/hud');
    assert.equal(status.isLinkedWorktree, true);
    assert.equal(status.worktreeName, 'review worktree');
    assert.equal(status.worktreeRoot, fs.realpathSync(linked));
    assert.equal(status.githubRepo, 'example/project');
    const display = stripAnsi(renderProjectLine({ git: status, project: { projectName: 'nested folder' } }));
    assert.match(display, /\[WT:review worktree\]/);
    assert.match(display, /git:\(feature\/hud/);
    assert.equal(collectGitStatus(main).isLinkedWorktree, false);
    assert.equal(collectGitStatus(main).branch, 'main');
    git('remote', 'set-url', 'origin', 'https://placeholder@github.com/example/project.git');
    assert.equal(collectGitStatus(main).githubRepo, 'example/project');
    git('remote', 'set-url', 'origin', 'https://notgithub.com/example/project.git');
    assert.equal(collectGitStatus(main).githubRepo, undefined);
    assert.equal(collectGitStatus(root).isGitRepo, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

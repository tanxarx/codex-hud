import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { SessionFinder } from '../../dist/collectors/session-finder.js';

const entry = fileURLToPath(new URL('../../dist/remote-launch.js', import.meta.url));
const wsModule = createRequire(import.meta.url).resolve('ws');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  assert.fail(`Timed out: ${description}`);
}

test('remote relay binds each native client and preserves protocol traffic and process lifecycle', async () => {
  const protectedDirectory = spawnSync(process.execPath, [entry, '--create-directory'], { encoding: 'utf8' });
  assert.equal(protectedDirectory.status, 0, protectedDirectory.stderr);
  const protectedPath = protectedDirectory.stdout.trim();
  assert.equal(path.dirname(protectedPath), path.join(fs.realpathSync('/tmp'), `codex-daemon-${process.getuid()}`));
  assert.equal(fs.statSync(protectedPath).mode & 0o777, 0o700);
  fs.rmdirSync(protectedPath);
  const root = fs.mkdtempSync('/tmp/codex-hud-relay-test.');
  const originalEnv = { ...process.env };
  const children = [];
  const peers = [];
  const server = createServer();
  const wss = new WebSocketServer({ server, maxPayload: 0 });
  wss.on('connection', (socket, request) => peers.push({ socket, headers: request.headers }));
  const backend = path.join(root, 'native.sock');
  server.listen(backend);
  await once(server, 'listening');
  const fixture = path.join(root, 'native-client.mjs');
  // A real WebSocket client launched as the relay's child, driven over stdin.
  fs.writeFileSync(fixture, `
import WebSocket from ${JSON.stringify(wsModule)};
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
const i = args.findIndex(arg => arg === '--remote' || arg.startsWith('--remote='));
const remote = args[i].startsWith('--remote=') ? args[i].slice(9) : args[i + 1];
let ws;
function connect() {
  ws = new WebSocket('ws+unix://' + remote.slice(7) + ':/', {
    headers: { authorization: 'Bearer hud-test', origin: 'https://hud-test.invalid' }, maxPayload: 0,
  });
  ws.on('open', () => console.log(JSON.stringify({ ready: true, args })));
  ws.on('message', (data, binary) => console.log(JSON.stringify({
    text: data.length < 2048 ? data.toString() : null, binary, size: data.length,
    digest: createHash('sha256').update(data).digest('hex'),
  })));
  ws.on('close', () => console.log(JSON.stringify({ closed: true })));
  ws.on('error', error => console.error(error.message));
}
connect();
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  if (command.exit !== undefined) process.exit(command.exit);
  else if (command.reconnect) connect();
  else ws.send(command.data, { binary: command.binary ?? false });
});
`);
  try {
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace with spaces');
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    fs.mkdirSync(workspace);
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;

    async function launch(pane, equals) {
      const directory = path.join(root, `launch-${children.length}`);
      fs.mkdirSync(directory, { mode: 0o700 });
      const remoteArgs = equals ? [`--remote=unix://${backend}`] : ['--remote', `unix://${backend}`];
      const child = spawn(process.execPath, [entry, directory, process.execPath, fixture,
        ...remoteArgs, '-C', workspace, '--', 'literal --remote prompt'], {
        env: { ...process.env, TMUX_PANE: pane }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.push(child);
      const exited = once(child, 'exit');
      const messages = [];
      let errors = '';
      child.stderr.on('data', chunk => { errors += chunk; });
      createInterface({ input: child.stdout }).on('line', line => messages.push(JSON.parse(line)));
      const ready = await waitFor(() => messages.find(message => message.ready), `client ready: ${pane}`);
      assert.deepEqual(ready.args.slice(-4), ['-C', workspace, '--', 'literal --remote prompt']);
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(directory, 'relay.sock')).mode & 0o777, 0o600);
      const peer = peers[children.length - 1];
      assert.equal(peer.headers.authorization, 'Bearer hud-test');
      assert.equal(peer.headers.origin, 'https://hud-test.invalid');
      const finder = new SessionFinder(workspace);
      const current = () => {
        process.env.CODEX_HUD_MAIN_PANE = pane;
        process.env.CODEX_HUD_BINDING_FILE = path.join(directory, 'binding.json');
        return finder.check();
      };
      const send = command => child.stdin.write(`${JSON.stringify(command)}\n`);
      const forward = async message => {
        const received = once(peer.socket, 'message');
        const data = JSON.stringify(message);
        send({ data });
        assert.equal((await received)[0].toString(), data);
      };
      return { directory, child, exited, messages, current, send, forward, peer, errors: () => errors };
    }

    function rollout(threadId) {
      const file = path.join(home, 'sessions', `rollout-2020-01-01T00-00-00-${threadId}.jsonl`);
      fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd: workspace } }) + '\n');
      return file;
    }
    async function reply(client, requestId, thread, extra = {}) {
      const count = client.messages.length;
      client.peer.socket.send(JSON.stringify({ id: requestId, result: { thread: {
        id: thread, path: rollout(thread), cwd: workspace, ephemeral: false, ...extra,
      } } }));
      await waitFor(() => client.messages.length > count, 'native response forwarded');
    }
    const A = '11111111-1111-7111-8111-111111111111';
    const B = '22222222-2222-7222-8222-222222222222';
    const C = '33333333-3333-7333-8333-333333333333';
    const a = await launch('%70', false);
    const b = await launch('%71', true);
    assert.equal(a.current(), null);
    assert.equal(b.current(), null);
    for (const [client, thread] of [[a, A], [b, B]]) {
      await client.forward({ id: 1, method: 'thread/start', params: {} });
      await reply(client, 1, thread);
      assert.equal(client.current().sessionId, thread);
    }
    // Broadcasts, title helpers, errors, and string IDs must not steal the root.
    a.peer.socket.send(JSON.stringify({ method: 'thread/started', params: { thread: { id: B } } }));
    await a.forward({ id: 2, method: 'thread/start', params: { ephemeral: true } });
    await reply(a, 2, C, { ephemeral: true });
    await a.forward({ id: 3, method: 'thread/start', params: {} });
    await reply(a, 3, C, { threadSource: 'thread_title' });
    await a.forward({ id: 4, method: 'thread/resume', params: { threadId: C } });
    await reply(a, '4', C);
    assert.equal(a.current().sessionId, A, 'numeric and string request IDs are distinct');
    a.peer.socket.send(JSON.stringify({ id: 4, error: { code: -1, message: 'resume failed' } }));
    await a.forward({ id: 5, method: 'thread/resume', params: { threadId: C } });
    await reply(a, 5, C);
    assert.equal(a.current().sessionId, C);
    assert.equal(b.current().sessionId, B, 'same-folder peer must retain its own root');
    await b.forward({ id: 2, method: 'thread/fork', params: { threadId: B } });
    await reply(b, 2, A);
    assert.equal(b.current().sessionId, A);

    const approval = { id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: C } };
    a.peer.socket.send(JSON.stringify(approval));
    await waitFor(() => a.messages.find(message => message.text === JSON.stringify(approval)), 'approval forwarded');
    await a.forward({ id: 'approval-1', result: { decision: 'decline' } });
    const raw = once(a.peer.socket, 'message');
    a.send({ data: 'unparsed bytes', binary: true });
    const [data, binary] = await raw;
    assert.equal(data.toString(), 'unparsed bytes');
    assert.equal(binary, true);
    const large = 'x'.repeat(17 * 1024 * 1024);
    a.peer.socket.send(large);
    const delivered = await waitFor(() => a.messages.find(message => message.size === large.length), 'reply larger than 16 MiB');
    assert.equal(delivered.digest, createHash('sha256').update(large).digest('hex'));
    assert.equal(delivered.binary, false);

    await a.forward({ id: 6, method: 'thread/unsubscribe', params: { threadId: C } });
    assert.equal(a.current(), null);
    a.peer.socket.terminate();
    await waitFor(() => a.messages.find(message => message.closed), 'upstream disconnect');
    assert.equal(a.current(), null);
    a.send({ reconnect: true });
    await waitFor(() => a.messages.filter(message => message.ready).length === 2, 'reconnect');
    const reconnected = peers.at(-1).socket;
    const request = once(reconnected, 'message');
    a.send({ data: JSON.stringify({ id: 7, method: 'thread/resume', params: { threadId: B } }) });
    await request;
    reconnected.send(JSON.stringify({ id: 7, result: { thread: { id: B, path: rollout(B) } } }));
    await waitFor(() => a.current()?.sessionId === B, 'reconnect binding');
    a.send({ exit: 23 });
    assert.deepEqual(await a.exited, [23, null]);
    assert.equal(fs.existsSync(a.directory), false);
    b.child.kill('SIGTERM');
    assert.deepEqual(await b.exited, [143, null]);
    assert.equal(fs.existsSync(b.directory), false);
    assert.equal(a.errors() + b.errors(), '');
  } finally {
    process.env = originalEnv;
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    for (const peer of peers) peer.socket.terminate();
    wss.close();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

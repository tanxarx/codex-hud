/** Launch one Codex TUI through a private relay, recording only its native thread replies. */
import { createServer } from 'node:http';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import WebSocket, { WebSocketServer } from 'ws';

if (process.argv[2] === '--create-directory') {
  // Codex hides this fixed rendezvous root from tool sandboxes. A privileged
  // RPC relay must not introduce an alternative listener in writable /tmp.
  const root = join(realpathSync('/tmp'), `codex-daemon-${process.getuid!()}`);
  try {
    try { mkdirSync(root, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700) {
      throw new Error('Daemon socket directory must be an owned, non-symlink directory with mode 0700');
    }
    console.log(mkdtempSync(join(root, 'hud-')));
    process.exit(0);
  } catch (error) {
    console.error(`[codex-hud] Cannot create a protected remote relay: ${String(error)}`);
    process.exit(1);
  }
}

const [directory, executable, ...args] = process.argv.slice(2);
const remoteIndex = args.findIndex((arg, index) =>
  (arg === '--remote' || arg.startsWith('--remote=')) &&
  (args.indexOf('--') === -1 || index < args.indexOf('--')));
const remote = args[remoteIndex]?.startsWith('--remote=')
  ? args[remoteIndex].slice('--remote='.length) : args[remoteIndex + 1];

if (!directory || !executable || remoteIndex < 0 || !remote?.startsWith('unix:///')) {
  console.error('[codex-hud] Remote relay requires a command and an absolute unix:// socket.');
  process.exit(1);
}

const socketPath = join(directory, 'relay.sock');
const bindingFile = join(directory, 'binding.json');
const sockets = new Set<WebSocket>();
const server = createServer((_request, response) => {
  response.writeHead(400); response.end('WebSocket upgrade required');
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 0 });
let stopping = false;
let clientConnected = false;

function bind(threadId: string | null, rolloutPath?: string): void {
  if (stopping) return;
  try {
    const temporary = `${bindingFile}.tmp`;
    writeFileSync(temporary, JSON.stringify({
      version: 1, paneId: process.env.TMUX_PANE, threadId, rolloutPath,
    }), { mode: 0o600 });
    renameSync(temporary, bindingFile);
  } catch (error) {
    console.error(`[codex-hud] Unable to record remote thread: ${String(error)}`);
  }
}

server.on('upgrade', (request, socket, head) => {
  // A relay belongs to exactly one native client. Accept reconnects after it closes.
  if (stopping || clientConnected) { socket.destroy(); return; }
  clientConnected = true;
  const headers: Record<string, string> = {};
  for (const name of ['authorization', 'origin']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  const upstream = new WebSocket(`ws+unix://${remote.slice('unix://'.length)}:${request.url ?? '/'}`, {
    headers, handshakeTimeout: 5000, maxPayload: 0,
  });
  sockets.add(upstream);
  let downstream: WebSocket | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clientConnected = false;
    bind(null);
    for (const ws of [upstream, downstream]) {
      if (ws) { sockets.delete(ws); ws.terminate(); }
    }
    socket.destroy();
  };
  upstream.on('error', close);
  upstream.on('close', close);
  socket.on('error', close);
  socket.on('close', close);
  upstream.once('open', () => {
    if (socket.destroyed || stopping) { close(); return; }
    wss.handleUpgrade(request, socket, head, client => {
      downstream = client;
      sockets.add(client);
      const pending = new Map<string, string>();
      let currentThread: string | null = null;
      client.on('message', (data, binary) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.id !== undefined && ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) {
            pending.set(`${typeof message.id}:${message.id}`, message.method);
          }
          if (message.method === 'thread/unsubscribe' && message.params?.threadId === currentThread) {
            currentThread = null; bind(null);
          }
        } catch { /* Native endpoints validate the protocol; all bytes still pass through. */ }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      });
      upstream.on('message', (data, binary) => {
        try {
          const message = JSON.parse(data.toString());
          const key = `${typeof message.id}:${message.id}`;
          if (!message.method && pending.delete(key) && !message.error) {
            const thread = message.result?.thread;
            if (typeof thread?.id === 'string' && /^[a-f0-9-]+$/.test(thread.id) &&
                !thread.ephemeral && thread.threadSource !== 'thread_title') {
              currentThread = thread.id;
              bind(thread.id, typeof thread.path === 'string' ? thread.path : undefined);
            }
          }
        } catch { /* Observation must never consume or change native messages. */ }
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
      });
      client.on('error', close);
      client.on('close', close);
    });
  });
});

function cleanup(): void {
  stopping = true;
  for (const ws of sockets) ws.terminate();
  server.close();
  rmSync(directory, { recursive: true, force: true });
}
process.once('exit', cleanup);

try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  bind(null);
  const localRemote = `unix://${socketPath}`;
  if (args[remoteIndex].startsWith('--remote=')) args[remoteIndex] = `--remote=${localRemote}`;
  else args[remoteIndex + 1] = localRemote;
  const child = spawn(executable, args, { stdio: 'inherit' });
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      child.kill(signal);
      setTimeout(() => { child.kill('SIGKILL'); process.exit(128 + constants.signals[signal]); }, 3000).unref();
    });
  }
  child.once('error', error => {
    console.error(`[codex-hud] Unable to launch Codex: ${error.message}`);
    process.exit(127);
  });
  child.once('exit', (code, signal) => {
    process.exit(code ?? (signal ? 128 + constants.signals[signal] : 1));
  });
} catch (error) {
  console.error(`[codex-hud] Unable to start remote relay: ${String(error)}`);
  process.exit(1);
}

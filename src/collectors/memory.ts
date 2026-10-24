import * as os from 'node:os';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';

let cached: { usedBytes: number; totalBytes: number } | undefined;
let checkedAt = 0;

/** Approximate physical use, excluding reclaimable caches where the OS reports them. */
export function collectMemoryUsage(): { usedBytes: number; totalBytes: number } {
  if (cached && Date.now() - checkedAt < 5000) return cached;
  const totalBytes = os.totalmem();
  let usedBytes = totalBytes - os.freemem();
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/bin/vm_stat', [], { encoding: 'utf8', timeout: 1000 });
    const text = result.status === 0 ? result.stdout : '';
    const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
    const pages = ['Pages active', 'Pages wired down', 'Pages occupied by compressor']
      .map(name => Number(text.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1]));
    if (pageSize > 0 && pages.every(Number.isFinite)) {
      usedBytes = pages.reduce((a, b) => a + b, 0) * pageSize;
    }
  } else if (process.platform === 'linux') {
    try {
      const available = Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m)?.[1]);
      if (Number.isFinite(available)) usedBytes = totalBytes - available * 1024;
    } catch { /* Keep the portable approximate value. */ }
  }
  checkedAt = Date.now();
  cached = { usedBytes: Math.max(0, Math.min(totalBytes, usedBytes)), totalBytes };
  return cached;
}

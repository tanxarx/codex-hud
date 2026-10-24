import type { HudData, RateLimitWindow } from '../../types.js';
import { colors, coloredBar, theme } from '../colors.js';

function count(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

function duration(seconds: number): string {
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d${Math.floor(seconds % 86400 / 3600)}h`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds)}s`;
}

export function renderCacheLine(data: HudData): string {
  const usage = data.tokenUsage?.last_token_usage;
  if (usage?.cached_input_tokens === undefined) return colors.dim('Cache: waiting for usage data');
  const cached = Math.max(0, usage.cached_input_tokens);
  const percent = usage.input_tokens && usage.input_tokens > 0
    ? Math.min(100, Math.round(cached / usage.input_tokens * 100)) : 0;
  const parts = [colors.dim('Cache: ') + theme.success(`${count(cached)} read (${percent}% hit)`)];
  const observed = data.tokenUsage?.observedAt?.getTime();
  const configured = process.env.CODEX_HUD_CACHE_TTL_SECONDS;
  // Codex rollouts do not report cache TTL/expiry. A user-provided idle window
  // is a reminder, never an assertion about server-side cache availability.
  const ttl = configured && /^\d+$/.test(configured) ? Number(configured) : 0;
  if (observed !== undefined && Number.isFinite(observed) && cached > 0) {
    const age = Math.max(0, (Date.now() - observed) / 1000);
    parts.push(colors.dim(`last hit ${duration(age)} ago`));
    if (ttl > 0 && Number.isSafeInteger(ttl)) {
      const remaining = ttl - age;
      const expiry = new Date(observed + ttl * 1000);
      if (Number.isFinite(expiry.getTime())) {
        const time = expiry.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        parts.push((remaining > 0 ? theme.warning : colors.dim)(remaining > 0
          ? `~expiry ${time} (${duration(remaining)}, ${duration(ttl)} estimate)`
          : `expiry estimate elapsed (${duration(ttl)} assumption)`));
      }
    } else {
      parts.push(colors.dim('expiry not reported'));
    }
  } else {
    parts.push(colors.dim('expiry not reported'));
  }
  return parts.join(' | ');
}

export function renderQuotaLine(data: HudData): string | null {
  if (!data.rateLimits) return null;
  const parts: string[] = [];
  for (const [fallback, window] of [['primary', data.rateLimits.primary], ['secondary', data.rateLimits.secondary]] as const) {
    if (!window || !Number.isFinite(window.used_percent)) continue;
    const minutes = window.window_minutes;
    const label = minutes && minutes > 0
      ? minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`
      : fallback;
    const used = Math.max(0, Math.min(100, window.used_percent));
    const reset = resetDisplay(window);
    parts.push(`${label} ${coloredBar(used, 8)} ${Math.round(used)}%${reset}`);
  }
  return parts.length ? colors.dim('Usage: ') + parts.join(' | ') : null;
}

function resetDisplay(window: RateLimitWindow): string {
  if (!window.resets_at || !Number.isFinite(window.resets_at)) return '';
  const seconds = window.resets_at - Date.now() / 1000;
  return colors.dim(seconds > 0 ? ` (resets in ${duration(seconds)})` : ' (awaiting refresh)');
}

export function renderMemoryLine(data: HudData): string | null {
  const memory = data.memory;
  if (!memory || !Number.isFinite(memory.totalBytes) || memory.totalBytes <= 0) return null;
  const used = Math.max(0, Math.min(memory.totalBytes, memory.usedBytes));
  const percent = Math.round(used / memory.totalBytes * 100);
  return `${colors.dim('Approx RAM: ')}${coloredBar(percent, 10)} ` +
    `${(used / 2 ** 30).toFixed(1)} / ${(memory.totalBytes / 2 ** 30).toFixed(0)} GB (${percent}%)`;
}

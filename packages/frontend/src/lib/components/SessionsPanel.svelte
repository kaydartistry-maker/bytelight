<script lang="ts">
  import { onMount } from 'svelte';

  interface SessionInfo {
    session_id: string;
    thread_id: string;
    thread_name: string | null;
    session_type: 'v1' | 'v2';
    started_at: string;
    ended_at: string | null;
    end_reason: string | null;
    peak_memory_mb: number | null;
    platform: string | null;
  }

  let sessions = $state<SessionInfo[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Relative "when" for the start time (used bottom-right).
  function relativeTime(iso: string): string {
    const date = new Date(iso);
    const diff = Date.now() - date.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
    const days = Math.floor(diff / 86400000);
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
  }

  // Compact elapsed for a live session ("4m", "2h", "1d").
  function shortAge(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return 'now';
    if (diff < 3600000) return `${Math.round(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)}h`;
    return `${Math.floor(diff / 86400000)}d`;
  }

  // How long an ended session ran.
  function duration(startedAt: string, endedAt: string): string {
    const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    if (ms < 0) return '—';
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const mins = Math.floor(totalSec / 60);
    if (mins < 60) {
      const sec = totalSec % 60;
      return sec > 0 ? `${mins}m ${String(sec).padStart(2, '0')}s` : `${mins}m`;
    }
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  }

  // Friendly reason a session closed.
  function endReasonLabel(reason: string | null): string {
    switch (reason) {
      case 'compaction': return 'compaction';
      case 'reaper': return 'timed out';
      case 'daily_rotation': return 'daily reset';
      case 'error': return 'error';
      case 'manual': return 'manual';
      case 'resumed': return 'resumed';
      default: return 'ended';
    }
  }

  // Channel badge: label + an rgb triplet that drives its color (border/dot/text).
  function channelMeta(platform: string | null): { label: string; rgb: string } {
    switch ((platform ?? 'web').toLowerCase()) {
      case 'discord': return { label: 'Discord', rgb: '236, 72, 153' };
      case 'telegram': return { label: 'Telegram', rgb: '56, 139, 253' };
      case 'api': return { label: 'API', rgb: '148, 163, 184' };
      default: return { label: 'Web', rgb: '45, 212, 191' };
    }
  }

  onMount(async () => {
    try {
      const res = await fetch('/api/sessions?limit=50', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      sessions = data.sessions || [];
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load sessions';
    } finally {
      loading = false;
    }
  });
</script>

<div class="panel">
  <h2 class="panel-title">Agent Sessions</h2>

  {#if loading}
    <div class="loading">Loading sessions...</div>
  {:else if error}
    <div class="error-note">{error}</div>
  {:else if sessions.length === 0}
    <div class="empty-note">No sessions found.</div>
  {:else}
    <div class="session-list">
      {#each sessions as session}
        {@const ch = channelMeta(session.platform)}
        <div class="session-card">
          <div class="session-top">
            <span class="session-badge" style="--ch: {ch.rgb}">{ch.label}</span>
            {#if session.ended_at}
              <span class="session-status">ended · {endReasonLabel(session.end_reason)}</span>
            {:else}
              <span class="session-status live">live · {shortAge(session.started_at)}</span>
            {/if}
          </div>

          <div class="session-title">{session.thread_name || 'Untitled thread'}</div>

          <div class="session-foot">
            {#if session.ended_at}
              <span class="session-dur">{duration(session.started_at, session.ended_at)}</span>
            {:else}
              <span class="session-dur muted">running</span>
            {/if}
            <span class="session-when">{relativeTime(session.started_at)}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .panel-title {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .loading, .empty-note {
    color: var(--text-muted);
    font-size: 0.875rem;
    font-style: italic;
  }

  .error-note {
    color: var(--status-error, #ef4444);
    font-size: 0.875rem;
  }

  .session-list {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .session-card {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.9rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  .session-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  /* Channel pill — color driven by --ch (an rgb triplet). */
  .session-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.15rem 0.65rem;
    border: 1px solid rgba(var(--ch), 0.5);
    border-radius: 999px;
    color: rgb(var(--ch));
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    white-space: nowrap;
  }

  .session-badge::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: rgb(var(--ch));
    flex-shrink: 0;
  }

  .session-status {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .session-status::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
  }

  .session-status.live {
    color: var(--status-active, #34d399);
  }

  .session-status.live::before {
    background: var(--status-active, #34d399);
    box-shadow: 0 0 6px var(--status-active, #34d399);
  }

  .session-title {
    font-size: 0.95rem;
    line-height: 1.35;
    color: var(--text-primary);
    font-weight: 500;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .session-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .session-dur {
    color: var(--text-secondary);
  }

  .session-dur::before {
    content: '⏱ ';
    opacity: 0.7;
  }

  .session-dur.muted {
    color: var(--text-muted);
  }

  .session-dur.muted::before {
    content: '';
  }
</style>

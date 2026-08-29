/**
 * Memory profiler — read-only observability for leak diagnostics (Track A.5).
 *
 * Vector cache was ruled out as the growth source (~16.5 MB steady-state).
 * This module logs a periodic trend line and exposes an on-demand snapshot
 * via GET /internal/memstats. It does NOT modify runtime behavior.
 */

import { getCacheStats } from './vector-cache.js';
import { registry } from './ws.js';

const MB = 1024 * 1024;

function toMb(bytes: number): number {
  return Math.round((bytes / MB) * 10) / 10;
}

function wsCount(): number {
  return registry.getCount();
}

export function getMemorySnapshot(): {
  rss_mb: number;
  heap_used_mb: number;
  heap_total_mb: number;
  external_mb: number;
  array_buffers_mb: number;
  ws_connections: number;
  vector_cache_mb: number;
  vector_cache_count: number;
  uptime_seconds: number;
  node_version: string;
  timestamp: string;
} {
  const mem = process.memoryUsage();
  const vc = getCacheStats();
  return {
    rss_mb: toMb(mem.rss),
    heap_used_mb: toMb(mem.heapUsed),
    heap_total_mb: toMb(mem.heapTotal),
    external_mb: toMb(mem.external),
    array_buffers_mb: toMb(mem.arrayBuffers),
    ws_connections: wsCount(),
    vector_cache_mb: vc.memoryMb,
    vector_cache_count: vc.count,
    uptime_seconds: Math.round(process.uptime()),
    node_version: process.version,
    timestamp: new Date().toISOString(),
  };
}

export function startMemoryProfiler(intervalMs: number = 15 * 60 * 1000): void {
  const ref = setInterval(() => {
    const s = getMemorySnapshot();
    console.log(
      `[memory] rss=${s.rss_mb}mb heapUsed=${s.heap_used_mb}mb heapTotal=${s.heap_total_mb}mb ` +
      `external=${s.external_mb}mb arrayBuffers=${s.array_buffers_mb}mb ws=${s.ws_connections} ` +
      `vc=${s.vector_cache_mb}mb vc_count=${s.vector_cache_count}`
    );
  }, intervalMs);
  ref.unref();
}

// Semantic embeddings through an isolated child process. The main server never
// loads onnxruntime, so native model memory cannot take down the daemon.
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EMBEDDING_DIM = 384;
const WORKER_MAX_RSS_MB = Number(process.env.EMBED_WORKER_MAX_RSS_MB) || 400;
const EMBED_TIMEOUT_MS = 60_000;

interface Pending { resolve: (value: Float32Array) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; text: string; retried: boolean; }
let worker: ChildProcess | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let retireWhenDrained = false;
let totalEmbeds = 0;
let embedsSinceLoad = 0;
let lastWorkerRssMb = 0;

export function getEmbedStats(): { totalEmbeds: number; embedsSinceLoad: number; inFlight: number; workerRssMb: number } {
  return { totalEmbeds, embedsSinceLoad, inFlight: pending.size, workerRssMb: lastWorkerRssMb };
}

function spawnWorker(): ChildProcess {
  const workerPath = fileURLToPath(new URL('./embeddings-worker.js', import.meta.url));
  const child = fork(workerPath, [], {
    serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    execArgv: process.execArgv.filter((arg) => arg.startsWith('--') && !arg.startsWith('--inspect') && !arg.startsWith('--input-type') && !arg.startsWith('--eval')),
  });
  embedsSinceLoad = 0;
  retireWhenDrained = false;
  child.on('message', (msg: { id: number; vector?: Float32Array; error?: string; rssMb?: number; embedsSinceSpawn?: number }) => {
    const request = pending.get(msg.id);
    if (!request) return;
    pending.delete(msg.id); clearTimeout(request.timer);
    if (msg.vector) {
      totalEmbeds++; embedsSinceLoad = msg.embedsSinceSpawn ?? embedsSinceLoad + 1; lastWorkerRssMb = msg.rssMb ?? lastWorkerRssMb; request.resolve(msg.vector);
    } else request.reject(new Error(`embeddings worker: ${msg.error || 'unknown error'}`));
    if (msg.rssMb && msg.rssMb > WORKER_MAX_RSS_MB) retireWhenDrained = true;
    if (retireWhenDrained && pending.size === 0 && worker === child) { console.log(`[embeddings] Retiring worker at ${msg.rssMb}MB RSS (limit ${WORKER_MAX_RSS_MB}MB).`); worker = null; child.kill(); }
  });
  child.on('exit', () => {
    if (worker === child) worker = null;
    for (const [id, request] of [...pending]) {
      pending.delete(id); clearTimeout(request.timer);
      if (request.retried) request.reject(new Error('embeddings worker died twice for this request'));
      else dispatch(request.text, true).then(request.resolve, request.reject);
    }
  });
  return child;
}

function dispatch(text: string, retried: boolean): Promise<Float32Array> {
  if (!worker) worker = spawnWorker();
  const child = worker; const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); console.warn(`[embeddings] Worker timeout after ${EMBED_TIMEOUT_MS}ms — killing worker.`); if (worker === child) worker = null; child.kill('SIGKILL'); reject(new Error('embeddings worker timed out')); }, EMBED_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, text, retried });
    child.send?.({ id, text }, (err) => { if (err && pending.has(id) && retried) { pending.delete(id); clearTimeout(timer); reject(err); } });
  });
}

export function embed(text: string): Promise<Float32Array> { return dispatch(text, false); }
/** Stop the sidecar during a graceful backend shutdown. */
export function shutdownEmbeddings(): void {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('embeddings service shutting down')); }
  pending.clear();
  if (worker) { worker.disconnect?.(); worker.kill(); worker = null; }
}
export function cosineSimilarity(a: Float32Array, b: Float32Array): number { let dot = 0; for (let i = 0; i < a.length; i++) dot += a[i] * b[i]; return dot; }
export function vectorToBuffer(v: Float32Array): Buffer { return Buffer.from(v.buffer, v.byteOffset, v.byteLength); }
export function bufferToVector(b: Buffer): Float32Array { return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
export { EMBEDDING_DIM };

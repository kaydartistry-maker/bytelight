import type { WebSocket } from 'ws';

export interface ConnectionRegistry {
  add(userId: string, ws: WebSocket): void;
  remove(userId: string, ws: WebSocket): void;
  broadcast(message: unknown): void;
  getCount(): number;
}

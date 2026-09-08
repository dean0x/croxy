import type { Duplex } from "node:stream";

/** Upgraded sockets leave http.Agent's pool, so their whole lifetime needs its own bound. */
export class WebSocketBudget {
  private readonly active = new Set<Duplex>();
  private readonly waiting = new Map<Duplex, () => void>();
  private closed = false;
  constructor(private readonly limit: number) {}
  run(socket: Duplex, start: () => void): void {
    if (this.closed || socket.destroyed) {
      socket.destroy();
      return;
    }
    if (this.active.has(socket)) {
      start();
      return;
    }
    socket.pause();
    socket.once("close", () => {
      this.active.delete(socket);
      this.waiting.delete(socket);
      this.drain();
    });
    this.waiting.set(socket, start);
    this.drain();
  }
  private drain(): void {
    if (this.closed) return;
    for (const [socket, start] of this.waiting) {
      if (this.active.size >= this.limit) break;
      this.waiting.delete(socket);
      if (socket.destroyed) continue;
      this.active.add(socket);
      start();
    }
  }
  close(): void {
    this.closed = true;
    for (const socket of [...this.active, ...this.waiting.keys()]) socket.destroy();
    this.waiting.clear();
    this.active.clear();
  }
}

/**
 * Coordinates the full-vault sync with lightweight per-path operations.
 *
 * Lightweight operations are "shared" readers: different paths may keep running concurrently.
 * A full sync is the exclusive writer: once requested it waits for active lightweight operations,
 * blocks new ones, then runs alone. Waiting writers have priority so a stream of file-change events
 * cannot starve a manual/periodic full sync indefinitely.
 *
 * This is deliberately independent of Obsidian/WebDAV so the concurrency contract stays small and
 * testable. Path-level serialization remains WatchOperations' responsibility.
 */
export class SyncActivityGate {
  private activeReaders = 0;
  private activeWriter = false;
  private readonly queue: Array<{ kind: 'shared' | 'exclusive'; resolve: () => void }> = [];

  async runShared<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquireShared();
    try {
      return await fn();
    } finally {
      this.releaseShared();
    }
  }

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquireExclusive();
    try {
      return await fn();
    } finally {
      this.releaseExclusive();
    }
  }

  private acquireShared(): Promise<void> {
    // Joining existing readers is safe only while no writer is active or already queued. Once a
    // writer waits, later readers queue behind it (writer preference prevents starvation).
    const writerQueued = this.queue.some((waiter) => waiter.kind === 'exclusive');
    if (!this.activeWriter && !writerQueued) {
      this.activeReaders++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push({
        kind: 'shared',
        resolve: () => {
          this.activeReaders++;
          resolve();
        },
      });
    });
  }

  private acquireExclusive(): Promise<void> {
    if (!this.activeWriter && this.activeReaders === 0 && this.queue.length === 0) {
      this.activeWriter = true;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push({
        kind: 'exclusive',
        resolve: () => {
          this.activeWriter = true;
          resolve();
        },
      });
    });
  }

  private releaseShared(): void {
    this.activeReaders = Math.max(0, this.activeReaders - 1);
    if (this.activeReaders === 0) this.drainQueue();
  }

  private releaseExclusive(): void {
    this.activeWriter = false;
    this.drainQueue();
  }

  private drainQueue(): void {
    if (this.activeWriter || this.activeReaders > 0 || this.queue.length === 0) return;

    // One exclusive waiter runs alone. Otherwise release the leading group of shared waiters
    // together; any shared waiter queued after an exclusive stays behind that writer.
    if (this.queue[0].kind === 'exclusive') {
      this.queue.shift()!.resolve();
      return;
    }

    while (this.queue.length > 0 && this.queue[0].kind === 'shared') {
      this.queue.shift()!.resolve();
    }
  }
}

/** Keeps one timer for independent local edit deadlines. */
export class WatchFileQueue {
  private readonly editedAt = new Map<string, number>();
  private timer: number | null = null;
  private scheduledAt = Number.POSITIVE_INFINITY;

  constructor(
    private readonly delayMs: () => number,
    private readonly canFlush: () => boolean,
    private readonly dispatch: (paths: string[]) => void,
    private readonly notBefore: (path: string) => number | undefined = () => undefined,
  ) {}

  add(path: string): void {
    const now = Date.now();
    this.editedAt.set(path, now);
    this.schedule(this.dueAt(path, now + this.delayMs()));
  }

  take(path: string): boolean {
    return this.editedAt.delete(path);
  }

  rebaseFolder(source: string, destination: string): void {
    for (const [path, time] of [...this.editedAt]) {
      if (path !== source && !path.startsWith(source + '/')) continue;
      const target = destination + path.slice(source.length);
      this.editedAt.delete(path);
      this.editedAt.set(target, Math.max(time, this.editedAt.get(target) ?? time));
    }
    this.refresh();
  }

  removeFolder(path: string): void {
    for (const key of this.editedAt.keys()) {
      if (key === path || key.startsWith(path + '/')) this.editedAt.delete(key);
    }
  }

  refresh(): void {
    this.cancelTimer();
    if (!this.canFlush()) return;
    const delay = this.delayMs();
    let next = Number.POSITIVE_INFINITY;
    for (const [path, time] of this.editedAt) next = Math.min(next, this.dueAt(path, time + delay));
    if (Number.isFinite(next)) this.schedule(next);
  }

  /** Hand already queued edits to Android's existing pre-suspension flush. */
  flushBeforeHide(): void {
    this.flush(true);
  }

  clear(): void {
    this.editedAt.clear();
    this.cancelTimer();
  }

  private schedule(at: number): void {
    if (!this.canFlush() || at >= this.scheduledAt) return;
    this.cancelTimer();
    this.scheduledAt = at;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.scheduledAt = Number.POSITIVE_INFINITY;
      if (this.canFlush()) this.flush(false);
    }, Math.max(0, at - Date.now()));
  }

  private flush(beforeHide: boolean): void {
    const now = Date.now();
    const delay = this.delayMs();
    const ready: string[] = [];
    for (const [path, time] of this.editedAt) {
      if (this.dueAt(path, beforeHide ? now : time + delay) > now) continue;
      this.editedAt.delete(path);
      ready.push(path);
    }
    this.refresh();
    if (ready.length) this.dispatch(ready);
  }

  private dueAt(path: string, editDeadline: number): number {
    return Math.max(editDeadline, this.notBefore(path) ?? 0);
  }

  private cancelTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.scheduledAt = Number.POSITIVE_INFINITY;
  }
}

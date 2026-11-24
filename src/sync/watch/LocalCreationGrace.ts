import { ancestorsOf } from '../../network/RemoteDirCache';

interface LocalCreation {
  createdAt: number;
  folder: boolean;
}

/** First-upload deadlines are local to this session and follow observed renames. */
export class LocalCreationGrace {
  private readonly entries = new Map<string, LocalCreation>();
  private pruneAt = 0;

  constructor(private readonly delayMs: () => number) {}

  add(path: string, folder: boolean): void {
    const delay = this.delayMs();
    if (delay <= 0) return;
    const now = Date.now();
    if (now >= this.pruneAt) {
      for (const [key, entry] of this.entries) {
        if (entry.createdAt + delay <= now) this.entries.delete(key);
      }
      this.pruneAt = now + delay;
    }
    this.entries.set(path, { createdAt: now, folder });
  }

  readyAt(path: string): number | undefined {
    if (!this.entries.size) return undefined;
    const delay = this.delayMs();
    if (delay <= 0) return undefined;
    const now = Date.now();
    let deadline = 0;
    for (const candidate of [...ancestorsOf(path), path]) {
      const entry = this.entries.get(candidate);
      if (!entry) continue;
      const ready = entry.createdAt + delay;
      if (ready <= now) this.entries.delete(candidate);
      else if (candidate === path || entry.folder) deadline = Math.max(deadline, ready);
    }
    return deadline || undefined;
  }

  rename(source: string, destination: string, folder: boolean): boolean {
    const entry = this.entries.get(source);
    const stillLocal = entry !== undefined && entry.createdAt + this.delayMs() > Date.now();
    if (!folder) {
      this.entries.delete(source);
      if (entry) this.entries.set(destination, entry);
      return stillLocal;
    }
    for (const [path, child] of [...this.entries]) {
      if (path !== source && !path.startsWith(source + '/')) continue;
      this.entries.delete(path);
      this.entries.set(destination + path.slice(source.length), child);
    }
    return stillLocal;
  }

  remove(path: string, folder: boolean): void {
    this.entries.delete(path);
    if (!folder) return;
    for (const key of this.entries.keys()) {
      if (key.startsWith(path + '/')) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

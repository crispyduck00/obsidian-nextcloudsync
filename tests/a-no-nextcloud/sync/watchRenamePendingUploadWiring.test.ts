import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression guard for the main.ts vault-event wiring.
 *
 * This behavior lives in the Obsidian host layer rather than WatchOperations itself: a modify event
 * enters the shared debounce queue, then a rename can happen before that queue flushes. The rename
 * handler must preserve that pending edit and reconcile the NEW path only after the remote MOVE has
 * settled. Keeping this as a source-contract test avoids introducing production helpers solely for
 * testability.
 */
describe('watch rename preserves a pending debounced edit', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf-8');
  const start = source.indexOf("this.registerEvent(this.app.vault.on('rename'");
  const end = source.indexOf("\n      }));", start);
  const handler = source.slice(start, end);

  it('remembers whether the old path had a pending upload', () => {
    expect(handler).toContain('const hadPendingUpload = pendingUploads.delete(oldPath);');
  });

  it('moves edit protection from the old path to the new path', () => {
    expect(handler).toContain('this.lastLocalEdit.delete(oldPath);');
    expect(handler).toContain('this.lastLocalEdit.set(newPath, lastEditAt);');
  });

  it('runs the remote rename before reconciling pending content at the new path', () => {
    const rename = handler.indexOf('const renamePromise = engine.renameSingleFile(oldPath, newPath);');
    const pendingGuard = handler.indexOf('if (hadPendingUpload)');
    const reconcile = handler.indexOf('void engine.syncSingleFile(newPath);');

    expect(rename).toBeGreaterThanOrEqual(0);
    expect(pendingGuard).toBeGreaterThan(rename);
    expect(reconcile).toBeGreaterThan(pendingGuard);
  });
});

import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression guard for the main.ts vault-event wiring.
 *
 * This behavior lives in the Obsidian host layer rather than WatchOperations itself: a modify event
 * enters the shared debounce queue, then a rename can happen before that queue flushes. The rename
 * handler must preserve that pending edit and reconcile the NEW path after the remote MOVE settles.
 *
 * The integrated Mobile Watch feature wraps the same queue operation in takePendingUpload(), while
 * the isolated upstream-based topic uses pendingUploads.delete() directly. This test intentionally
 * accepts either representation and pins the behavior instead of one composition-specific spelling.
 */
describe('watch rename preserves a pending debounced edit', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf-8');
  const renameStart = source.indexOf("this.registerEvent(this.app.vault.on('rename'");
  const renameEnd = source.indexOf("\n      }));", renameStart);
  const handler = source.slice(renameStart, renameEnd);

  it('remembers whether the old path had a pending upload', () => {
    expect(handler).toMatch(
      /const hadPendingUpload = (?:pendingUploads\.delete|takePendingUpload)\(oldPath\);/,
    );
  });

  it('moves edit protection from the old path to the new path', () => {
    expect(handler).toContain('this.lastLocalEdit.delete(oldPath);');
    expect(handler).toContain('this.lastLocalEdit.set(newPath, lastEditAt);');
  });

  it('desktop reconciles pending content at the new path only after starting the remote rename', () => {
    const desktop = handler.includes('// Desktop:')
      ? handler.slice(handler.indexOf('// Desktop:'))
      : handler;

    const rename = desktop.indexOf('const renamePromise = engine.renameSingleFile(oldPath, newPath);');
    const pendingGuard = desktop.indexOf('if (hadPendingUpload)', rename);
    const reconcile = desktop.indexOf('void engine.syncSingleFile(newPath);', pendingGuard);

    expect(rename).toBeGreaterThanOrEqual(0);
    expect(pendingGuard).toBeGreaterThan(rename);
    expect(reconcile).toBeGreaterThan(pendingGuard);
  });
});

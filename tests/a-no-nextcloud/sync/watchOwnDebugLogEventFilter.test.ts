import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression guard for main.ts's early vault-event filter.
 *
 * SyncEngine already excludes the active own debug log from actual synchronization. This host-level
 * guard is deliberately earlier: it keeps frequent FileLogger writes out of the shared Watch debounce
 * queue so they cannot perturb scheduling of real user edits.
 */
describe('watch event filter ignores the active own debug log before debounce', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf-8');
  const start = source.indexOf('const isOwnSyncEvent = (path: string): boolean =>');
  const end = source.indexOf(';\n\n      // Accumulate paths changed during rapid editing', start);
  const predicate = source.slice(start, end);

  it('checks the active own log in the early event predicate', () => {
    expect(predicate).toContain('isActiveOwnLog(path');
    expect(predicate).toContain('logsFolder: this.settings.logsFolder');
    expect(predicate).toContain('host: this.hostToken()');
    expect(predicate).toContain('loggingEnabled: this.settings.loggingEnabled');
  });

  it('keeps the existing tmp-path and LocalAdapter own-write guards', () => {
    expect(predicate).toContain('isSyncTmpPath(path)');
    expect(predicate).toContain('this.localAdapter?.shouldIgnore(path)');
  });
});

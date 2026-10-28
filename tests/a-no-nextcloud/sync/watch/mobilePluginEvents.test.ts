import { readFileSync } from 'fs';
import { resolve } from 'path';
import { transpileModule, ModuleKind } from 'typescript';
import { TFile, TFolder } from 'obsidian';
const File = TFile as unknown as new (path: string) => TFile;
const Folder = TFolder as unknown as new (path: string) => TFolder;
import { MobileWatchLifecycle } from '../../../../src/sync/watch/MobileWatchLifecycle';
import { isWatchModeActive } from '../../../../src/util/settingsMigration';
import { isUnderPluginsDir } from '../../../../src/sync/plugins/pluginPaths';

// Execute the production host wiring against event/engine doubles. This checks the filter BEFORE
// the lifecycle recovery decision; an engine-only test would miss a needless full sync already queued.
function host() {
  const source = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');
  const start = source.indexOf('      // Watch mode: Desktop');
  const rename = source.indexOf("this.registerEvent(this.app.vault.on('rename'", start);
  const end = source.indexOf('\n      if (mobileWatch) {', rename);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const body = transpileModule(source.slice(start, end), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  const events = new Map<string, (file: TFile | TFolder, oldPath?: string) => void>();
  const engine = { isSyncRunning: () => true, canRunWatchSync: () => true,
    syncForWatchRecovery: jest.fn(async () => true), syncSingleFileForMobileWatch: jest.fn(async () => true) };
  const self = { app: { vault: { configDir: '.obsidian', on: (event: string, fn: (file: TFile | TFolder, oldPath?: string) => void) => events.set(event, fn) } },
    settings: { watchOnChangeEnabled: true }, syncEngine: engine,
    lastLocalEdit: new Map(), logger: { log: () => undefined }, registerEvent: () => undefined,
    localAdapter: { shouldIgnore: () => false }, hostToken: () => 'test', refreshMobileConflictStatus: () => undefined };
  new Function('Platform', 'TFile', 'TFolder', 'MobileWatchLifecycle', 'isWatchModeActive', 'isUnderPluginsDir', 'isSyncTmpPath', 'debounce', 'EDIT_WINDOW_MS', 'document', 'isActiveOwnLog', body)
    .call(self, { isMobile: true, isIosApp: false }, TFile, TFolder, MobileWatchLifecycle, isWatchModeActive, isUnderPluginsDir, () => false, (fn: () => void) => fn, 0, { hidden: false }, () => false);
  return { events, engine };
}

it('keeps plugin temp/status and folder events out of Android recovery during a full sync', async () => {
  const h = host();
  for (let n = 0; n < 30; n++) {
    h.events.get('modify')!(new File('.obsidian/plugins/p/data.json'));
    h.events.get('create')!(new Folder('.obsidian/plugins/p/cache'));
    h.events.get('delete')!(new Folder('.obsidian/plugins/p/cache'));
    h.events.get('rename')!(new File('.obsidian/plugins/p/data.json'), '.obsidian/plugins/p/data.tmp');
  }
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(h.engine.syncSingleFileForMobileWatch).not.toHaveBeenCalled();
  expect(h.engine.syncForWatchRecovery).not.toHaveBeenCalled();
});

it('still queues a normal note when plugin events are noisy', async () => {
  const h = host();
  h.events.get('modify')!(new File('.obsidian/plugins/p/data.json'));
  h.events.get('modify')!(new File('notes/n.md'));
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(h.engine.syncSingleFileForMobileWatch).toHaveBeenCalledWith('notes/n.md');
  expect(h.engine.syncForWatchRecovery).not.toHaveBeenCalled();
});

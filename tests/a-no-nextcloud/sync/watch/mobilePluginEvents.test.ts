import { readFileSync } from 'fs';
import { resolve } from 'path';
import { transpileModule, ModuleKind } from 'typescript';
import { TFile, TFolder } from 'obsidian';
const File = TFile as unknown as new (path: string) => TFile;
const Folder = TFolder as unknown as new (path: string) => TFolder;
import { MobileWatchLifecycle } from '../../../../src/sync/watch/MobileWatchLifecycle';
import { LocalCreationGrace } from '../../../../src/sync/watch/LocalCreationGrace';
import { WatchFileQueue } from '../../../../src/sync/watch/WatchFileQueue';
import { isWatchModeActive } from '../../../../src/util/settingsMigration';
import { isUnderPluginsDir } from '../../../../src/sync/plugins/pluginPaths';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

// Execute the production host wiring against event/engine doubles. This checks the filter BEFORE
// the lifecycle recovery decision; an engine-only test would miss a needless full sync already queued.
function host({ running = true, newDelay = 0, ignoredPath = '' } = {}) {
  const source = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');
  const start = source.indexOf('      // Watch mode: Desktop');
  const rename = source.indexOf("this.registerEvent(this.app.vault.on('rename'", start);
  const end = source.indexOf('\n      if (mobileWatch) {', rename);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const body = transpileModule(source.slice(start, end), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  const events = new Map<string, (file: TFile | TFolder, oldPath?: string) => void>();
  const editorEvents = new Map<string, (editor: unknown, info: { file: TFile | null }) => void>();
  const grace = new LocalCreationGrace(() => newDelay);
  const engine = { isSyncRunning: () => running, canRunWatchSync: () => true,
    rememberLocalCreation: (path: string, folder: boolean) => grace.add(path, folder),
    retargetLocalCreation: (from: string, to: string, folder: boolean) => grace.rename(from, to, folder),
    forgetFolderDeletion: jest.fn(), rememberFolderRename: jest.fn(), rememberFileRename: jest.fn(),
    createSingleFolderForMobileWatch: jest.fn(async (_path: string) => true),
    retryMovesIntoFolder: jest.fn(async (_path: string) => undefined),
    syncForWatchRecovery: jest.fn(async () => true), syncSingleFileForMobileWatch: jest.fn(async () => true) };
  const self = { app: {
    vault: { configDir: '.obsidian', on: (event: string, fn: (file: TFile | TFolder, oldPath?: string) => void) => events.set(event, fn) },
    workspace: { on: (event: string, fn: (editor: unknown, info: { file: TFile | null }) => void) => editorEvents.set(event, fn) },
  },
    settings: { watchOnChangeEnabled: true, watchDebounceSeconds: 0 }, syncEngine: engine,
    localCreations: grace,
    lastLocalEdit: new Map(), logger: { log: () => undefined }, registerEvent: () => undefined,
    localAdapter: { shouldIgnore: (path: string) => path === ignoredPath },
    hostToken: () => 'test', refreshMobileConflictStatus: () => undefined };
  new Function('Platform', 'TFile', 'TFolder', 'MobileWatchLifecycle', 'isWatchModeActive', 'isUnderPluginsDir', 'isSyncTmpPath', 'WatchFileQueue', 'document', 'isActiveOwnLog', body)
    .call(self, { isMobile: true, isIosApp: false }, TFile, TFolder, MobileWatchLifecycle, isWatchModeActive,
      isUnderPluginsDir, () => false, WatchFileQueue, { hidden: false }, () => false);
  return { events, editorEvents, engine, edits: self.lastLocalEdit };
}

it('keeps plugin temp/status and folder events out of Android recovery during a full sync', async () => {
  const h = host();
  for (let n = 0; n < 30; n++) {
    h.events.get('modify')!(new File('.obsidian/plugins/p/data.json'));
    h.events.get('create')!(new Folder('.obsidian/plugins/p/cache'));
    h.events.get('delete')!(new Folder('.obsidian/plugins/p/cache'));
    h.events.get('rename')!(new File('.obsidian/plugins/p/data.json'), '.obsidian/plugins/p/data.tmp');
  }
  await jest.advanceTimersByTimeAsync(0);
  expect(h.engine.syncSingleFileForMobileWatch).not.toHaveBeenCalled();
  expect(h.engine.syncForWatchRecovery).not.toHaveBeenCalled();
});

it('records a real rename of a path still marked as recently downloaded', () => {
  const h = host({ ignoredPath: 'notes/downloaded.md' });
  h.events.get('rename')!(new File('notes/New heading.md'), 'notes/downloaded.md');
  expect(h.engine.rememberFileRename).toHaveBeenCalledWith('notes/downloaded.md', 'notes/New heading.md');
});

it('uses only the final paths after a rapid Folder Notes and H1 cascade on Android', async () => {
  const h = host({ running: false, newDelay: 10000 });
  h.events.get('create')!(new Folder('Untitled'));
  h.events.get('create')!(new File('Untitled/Untitled.md'));
  h.events.get('rename')!(new Folder('Project'), 'Untitled');
  h.events.get('rename')!(new File('Project/Project.md'), 'Project/Untitled.md');
  await jest.advanceTimersByTimeAsync(9999);
  expect(h.engine.createSingleFolderForMobileWatch).not.toHaveBeenCalled();
  expect(h.engine.syncSingleFileForMobileWatch).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(h.engine.createSingleFolderForMobileWatch.mock.calls).toEqual([['Project']]);
  expect(h.engine.syncSingleFileForMobileWatch).toHaveBeenCalledTimes(1);
  expect(h.engine.syncSingleFileForMobileWatch).toHaveBeenCalledWith('Project/Project.md');
  expect(h.engine.rememberFileRename).not.toHaveBeenCalled();
  expect(h.engine.rememberFolderRename).not.toHaveBeenCalled();
  expect(h.engine.syncForWatchRecovery).not.toHaveBeenCalled();
});

it('still queues a normal note when plugin events are noisy', async () => {
  const h = host();
  h.events.get('modify')!(new File('.obsidian/plugins/p/data.json'));
  h.events.get('modify')!(new File('notes/n.md'));
  await jest.advanceTimersByTimeAsync(0);
  expect(h.engine.syncSingleFileForMobileWatch).toHaveBeenCalledWith('notes/n.md');
  expect(h.engine.syncForWatchRecovery).not.toHaveBeenCalled();
});

it('protects unsaved edits even immediately after a download, then checks the saved note', async () => {
  const h = host({ ignoredPath: 'notes/downloaded.md' });
  const downloaded = new File('notes/downloaded.md');
  // Our vault write alone must not schedule work.
  h.events.get('modify')!(downloaded);
  await jest.advanceTimersByTimeAsync(0);
  expect(h.engine.syncSingleFileForMobileWatch).not.toHaveBeenCalled();
  const edited = h.editorEvents.get('editor-change')!;
  edited(undefined, { file: downloaded });
  edited(undefined, { file: new File('notes/unsaved.md') });
  expect([...h.edits.keys()]).toEqual(['notes/downloaded.md', 'notes/unsaved.md']);
  await jest.advanceTimersByTimeAsync(0);
  // The first check may have run before Obsidian saved. Its later modify must still reach watch.
  h.events.get('modify')!(downloaded);
  await jest.advanceTimersByTimeAsync(100);
  expect(h.engine.syncSingleFileForMobileWatch.mock.calls).toEqual([[downloaded.path], [downloaded.path]]);
  h.events.get('modify')!(downloaded);
  await jest.advanceTimersByTimeAsync(100);
  expect(h.engine.syncSingleFileForMobileWatch).toHaveBeenCalledTimes(2);
});

it.each(['editor-first', 'save-first'])('coalesces overlapping editor and vault notifications after a download (%s)', async order => {
  const file = new File('notes/downloaded.md');
  const h = host({ ignoredPath: file.path });
  const edit = () => h.editorEvents.get('editor-change')!(undefined, { file });
  const save = () => h.events.get('modify')!(file);
  for (const notify of (order === 'editor-first' ? [edit, save] : [save, edit])) notify();
  await jest.advanceTimersByTimeAsync(1);
  expect(h.engine.syncSingleFileForMobileWatch.mock.calls).toEqual([[file.path]]);
  expect(h.engine.syncForWatchRecovery).not.toHaveBeenCalled();
});

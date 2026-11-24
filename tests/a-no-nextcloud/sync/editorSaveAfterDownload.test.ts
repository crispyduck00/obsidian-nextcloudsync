import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ModuleKind, transpileModule } from 'typescript';
import { TFile, TFolder } from 'obsidian';
import { isSyncTmpPath } from '../../../src/data/LocalAdapter';

const File = TFile as unknown as new(path: string) => TFile;
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function host(enabled = true) {
  const source = readFileSync(resolve('src/main.ts'), 'utf8');
  const start = source.indexOf('      // Watch mode: single-file operations');
  const end = source.indexOf('      // Sync on foreground resume', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const body = transpileModule(source.slice(start, end), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  const events = new Map<string, (...args: any[]) => void>();
  const editor = new Map<string, (...args: any[]) => void>();
  const engine = { syncSingleFile: jest.fn(async () => undefined), renameSingleFile: jest.fn(async () => undefined),
    renameSingleFolder: jest.fn(async () => undefined) };
  const debounce = (fn: () => void, delay: number) => {
    let timer: ReturnType<typeof setTimeout>;
    return () => { clearTimeout(timer); timer = setTimeout(fn, delay); };
  };
  const self = { settings: { watchOnChangeEnabled: enabled }, lastLocalEdit: new Map<string, number>(),
    app: { vault: { on: (name: string, fn: (...args: any[]) => void) => events.set(name, fn) },
      workspace: { on: (name: string, fn: (...args: any[]) => void) => editor.set(name, fn) } },
    registerEvent: () => undefined, syncEngine: engine,
    localAdapter: { shouldIgnore: () => true } };
  new Function('TFile', 'TFolder', 'debounce', 'isSyncTmpPath', 'EDIT_WINDOW_MS', body)
    .call(self, TFile, TFolder, debounce, isSyncTmpPath, 2000);
  return { events, editor, engine, edits: self.lastLocalEdit };
}

test('a download echo alone never dispatches a Watch upload', async () => {
  const h = host();
  h.events.get('modify')!(new File('note.md'));
  await jest.advanceTimersByTimeAsync(2000);
  expect(h.engine.syncSingleFile).not.toHaveBeenCalled();
});

test.each(['editor-first', 'save-first'])('keeps a real editor save inside the download ignore window (%s)', async order => {
  const h = host();
  const file = new File('note.md');
  const edit = () => h.editor.get('editor-change')!(undefined, { file });
  const save = () => h.events.get('modify')!(file);
  for (const event of order === 'editor-first' ? [edit, save] : [save, edit]) event();
  expect(h.edits.has(file.path)).toBe(true);
  await jest.advanceTimersByTimeAsync(2000);
  expect(h.engine.syncSingleFile.mock.calls).toEqual([[file.path]]);
});

test('a later saved-file event reaches Watch after the early editor check already ran', async () => {
  const h = host();
  const file = new File('note.md');
  h.editor.get('editor-change')!(undefined, { file });
  await jest.advanceTimersByTimeAsync(2000);
  h.events.get('modify')!(file);
  await jest.advanceTimersByTimeAsync(2000);
  expect(h.engine.syncSingleFile).toHaveBeenCalledTimes(2);
  h.events.get('modify')!(file);
  await jest.advanceTimersByTimeAsync(2000);
  expect(h.engine.syncSingleFile).toHaveBeenCalledTimes(2);
});

test('unsaved editor changes stay protected while Watch is disabled', async () => {
  const h = host(false);
  h.editor.get('editor-change')!(undefined, { file: new File('note.md') });
  expect(h.edits.has('note.md')).toBe(true);
  await jest.advanceTimersByTimeAsync(2000);
  expect(h.engine.syncSingleFile).not.toHaveBeenCalled();
});


test('a user rename just after a download retains intent and rechecks the renamed content', async () => {
  const h = host();
  h.events.get('rename')!(new File('new heading.md'), 'note.md');
  await jest.advanceTimersByTimeAsync(0);
  expect(h.engine.renameSingleFile).toHaveBeenCalledWith('note.md', 'new heading.md');
  expect(h.engine.syncSingleFile).toHaveBeenCalledWith('new heading.md');
});

test('an atomic temporary-file rename never becomes a remote user rename', async () => {
  const h = host();
  h.events.get('rename')!(new File('note.md'), 'ncs-write.ncs.tmp');
  await jest.advanceTimersByTimeAsync(0);
  expect(h.engine.renameSingleFile).not.toHaveBeenCalled();
  expect(h.engine.syncSingleFile).not.toHaveBeenCalled();
});

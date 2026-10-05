// Direct tests for the session modules and VersionService (feature 074, addendum).
//
// No [SPEC:...] tags: URE-5 and the merge-base clauses stay with the engine-level suites.
//
// These three are small, which is why they had no tests: each looked too obvious to be worth one.
// What they actually encode is a rule apiece that is easy to get wrong when reading quickly — how
// history entries are grouped, which files deserve a merge base, and what "versions unsupported"
// really means.
import { SyncJournal } from '../../../../src/sync/session/SyncJournal';
import { MergeBaseRecorder } from '../../../../src/sync/session/MergeBaseRecorder';
import { VersionService } from '../../../../src/sync/versions/VersionService';
import { withLocalSignature } from '../../../../src/data/localSignature';
import {
  FileState, SyncSessionSummary, SyncFileOp, SyncHistoryDetail,
  FeatureUnsupportedError, NextcloudFeatures, FileVersion,
} from '../../../../src/types';
import { IWebDAVClient } from '../../../../src/network/IWebDAVClient';
import { LocalAdapter } from '../../../../src/data/LocalAdapter';

interface Recorded {
  path: string; op: SyncFileOp; at: number;
  message?: string; detail?: SyncHistoryDetail; runStartedAt?: number;
}

function journal() {
  const recorded: Recorded[] = [];
  const logged: string[] = [];
  const j = new SyncJournal({
    historyStore: {
      record: (path: string, op: SyncFileOp, at: number, message?: string, detail?: SyncHistoryDetail, runStartedAt?: number) =>
        recorded.push({ path, op, at, message, detail, runStartedAt }),
    } as never,
    logger: { log: (m: string) => { logged.push(m); } } as never,
  });
  return { j, recorded, logged };
}

describe('SyncJournal — grouping history by run', () => {
  it('tags every entry inside a run with that run\'s start time', () => {
    const { j, recorded } = journal();
    j.beginRun(1234);
    j.recordHistory('a.md', 'uploaded');
    j.recordHistory('b.md', 'downloaded');
    expect(recorded.map((r) => r.runStartedAt)).toEqual([1234, 1234]);
  });

  it('gives an entry outside a run its own group', () => {
    // Watch-mode single-file ops have no session, so each forms its own group in the dialog.
    const { j, recorded } = journal();
    j.recordHistory('a.md', 'uploaded');
    expect(recorded[0].runStartedAt).toBe(recorded[0].at);
  });

  it('stops grouping once the run ends', () => {
    const { j, recorded } = journal();
    j.beginRun(1234);
    j.recordHistory('during.md', 'uploaded');
    j.endRun();
    j.recordHistory('after.md', 'uploaded');
    expect(recorded[0].runStartedAt).toBe(1234);
    expect(recorded[1].runStartedAt).not.toBe(1234);
  });

  it('passes the message and detail through untouched', () => {
    const { j, recorded } = journal();
    const detail: SyncHistoryDetail = {
      localHash: 'lh', remoteId: 'ri', remoteIdType: 'sha256', localSize: 1, remoteSize: 2,
    };
    j.recordHistory('a.md', 'merged', 'why', detail);
    expect(recorded[0]).toMatchObject({ op: 'merged', message: 'why', detail });
  });

  it('is a no-op when no history store is injected', () => {
    const bare = new SyncJournal({});
    expect(() => bare.recordHistory('a.md', 'uploaded')).not.toThrow();
  });
});

describe('SyncJournal — recording errors', () => {
  function summary(): SyncSessionSummary {
    return {
      startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
      mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
    };
  }

  it('counts the error and keeps its detail for the status dialog', () => {
    const { j } = journal();
    const s = summary();
    j.recordError(s, 'a.md', new Error('HTTP 500 (PUT)'));
    expect(s.errorCount).toBe(1);
    expect(s.errors).toEqual([{ path: 'a.md', message: 'HTTP 500 (PUT)', skippedPaths: undefined, dirBreakerSkipped: undefined }]);
  });

  it('also writes a file-history entry, so the error shows on the file\'s timeline', () => {
    const { j, recorded } = journal();
    j.recordError(summary(), 'a.md', new Error('boom'));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ path: 'a.md', op: 'error', message: 'boom' });
  });

  it('does NOT write file history for a session-level error', () => {
    // An empty path means the session, not a file — it has no timeline to appear on.
    const { j, recorded } = journal();
    const s = summary();
    j.recordError(s, '', new Error('connect failed'));
    expect(s.errorCount).toBe(1);
    expect(recorded).toEqual([]);
  });

  it('stringifies a non-Error rejection rather than losing it', () => {
    const { j } = journal();
    const s = summary();
    j.recordError(s, 'a.md', 'plain string failure');
    expect(s.errors[0].message).toBe('plain string failure');
  });

  it('carries the breaker payloads through', () => {
    const { j } = journal();
    const s = summary();
    j.recordError(s, '(dir mass-delete breaker)', new Error('skipped'), undefined, {
      deleteRemote: ['a'], trashLocal: ['b'],
    });
    expect(s.errors[0].dirBreakerSkipped).toEqual({ deleteRemote: ['a'], trashLocal: ['b'] });
  });
});

describe('SyncJournal — logging every failure', () => {
  it('writes one line per error, with its path, and no cap', () => {
    // URE-5: issue #25 reported `err=162` with not one of the 162 paths identifiable. A truncated
    // summary is worthless when the log is the only evidence.
    const { j, logged } = journal();
    const errors = Array.from({ length: 200 }, (_, i) => ({ path: `f${i}.md`, message: 'HTTP 500' }));
    j.logSessionErrors({ errors } as SyncSessionSummary);
    expect(logged).toHaveLength(200);
    expect(logged[199]).toContain('f199.md');
  });

  it('is a no-op without a logger', () => {
    const bare = new SyncJournal({});
    expect(() => bare.logSessionErrors({ errors: [{ path: 'a', message: 'b' }] } as SyncSessionSummary))
      .not.toThrow();
  });
});

describe('SyncJournal.newSummary', () => {
  it('starts every counter at zero', () => {
    const { j } = journal();
    const s = j.newSummary();
    expect(s).toMatchObject({
      completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
      mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
    });
    expect(s.startedAt).toBeGreaterThan(0);
  });

  it('hands out an independent summary each time', () => {
    const { j } = journal();
    const a = j.newSummary();
    a.errors.push({ path: 'x', message: 'y' });
    expect(j.newSummary().errors).toEqual([]);
  });
});

describe('MergeBaseRecorder — which files get a base', () => {
  function recorder(types: string[] = ['md', 'txt'], withStore = true) {
    const store = new Map<string, string>();
    const saves = { count: 0 };
    return {
      rec: new MergeBaseRecorder({
        baseStore: withStore ? {
          set: (p: string, c: string) => { store.set(p, c); },
          delete: (p: string) => { store.delete(p); },
          requestSave: () => { saves.count++; },
        } as never : undefined,
        autoMergeFileTypes: () => types,
      }),
      store, saves,
    };
  }

  it('records a base for an auto-merge file type', () => {
    const { rec, store } = recorder();
    rec.record('notes/a.txt', 'body');
    expect(store.get('notes/a.txt')).toBe('body');
  });

  it('records a base for EVERY markdown file, even when md is not an auto-merge type', () => {
    // Feature 047: the frontmatter set-merge needs a base to detect deletions, regardless of how the
    // body is resolved.
    const { rec, store } = recorder(['txt']);
    rec.record('notes/a.md', 'body');
    expect(store.get('notes/a.md')).toBe('body');
  });

  it('records nothing for a file type that has neither', () => {
    const { rec, store, saves } = recorder(['md']);
    rec.record('img/a.png', 'bytes');
    expect(store.size).toBe(0);
    expect(saves.count).toBe(0); // and asks for no save
  });

  it('reads the configured types at call time', () => {
    let types = ['txt'];
    const rec = new MergeBaseRecorder({
      baseStore: { set: () => { /* noop */ }, delete: () => { /* noop */ }, requestSave: () => { /* noop */ } } as never,
      autoMergeFileTypes: () => types,
    });
    // A settings change between syncs must take effect without rebuilding the recorder.
    expect(() => { types = ['md']; rec.record('a.md', 'x'); }).not.toThrow();
  });

  it('drops a base unconditionally, whatever the file type', () => {
    const { rec, store, saves } = recorder(['md']);
    store.set('img/a.png', 'stale');
    rec.drop('img/a.png');
    expect(store.has('img/a.png')).toBe(false);
    expect(saves.count).toBe(1);
  });

  it('no-ops entirely when no store is injected', () => {
    const { rec } = recorder(['md'], false);
    expect(() => { rec.record('a.md', 'x'); rec.drop('a.md'); }).not.toThrow();
  });
});

describe('withLocalSignature', () => {
  const adapter = (stat: { size: number; mtime: number } | null) =>
    ({ stat: async () => stat }) as unknown as Pick<LocalAdapter, 'stat'>;

  const state = (): FileState => ({
    path: 'a.md', localHash: 'h', remoteId: 'r', idType: 'etag', size: 1, mtime: 2,
    remoteFileId: null, isConflicted: false,
  });

  it('stamps what the OS actually wrote', async () => {
    const out = await withLocalSignature(adapter({ size: 42, mtime: 99 }), state());
    expect(out).toMatchObject({ localSize: 42, localMtime: 99 });
  });

  it('leaves the signature undefined when the stat fails, so the file is simply hashed next time', async () => {
    const out = await withLocalSignature(adapter(null), state());
    expect(out.localMtime).toBeUndefined();
    expect(out.localSize).toBeUndefined();
  });

  it('records the remote mtime only when one is given', async () => {
    const withMtime = await withLocalSignature(adapter({ size: 1, mtime: 1 }), state(), 555);
    expect(withMtime.remoteMtime).toBe(555);
    const without = await withLocalSignature(adapter({ size: 1, mtime: 1 }), state(), null);
    expect(without.remoteMtime).toBeUndefined();
  });
});

describe('VersionService', () => {
  const NEXTCLOUD = { isNextcloud: true } as NextcloudFeatures;
  const PLAIN = { isNextcloud: false } as NextcloudFeatures;
  const version = { id: 'v1' } as unknown as FileVersion;

  function build(tracked?: FileState) {
    const calls: {
      listed: string[]; restored: string[]; fetchedVersions: string[]; downloaded: string[];
      wrote: string[]; saves: number; setFile?: FileState;
    } = { listed: [], restored: [], fetchedVersions: [], downloaded: [], wrote: [], saves: 0 };
    const client = {
      listVersions: async (fid: string) => { calls.listed.push(fid); return [version]; },
      statFile: async () => null,
      getVersionContent: async (v: FileVersion, fid: string) => {
        calls.fetchedVersions.push(`${fid}:${v.versionId}`);
        return new TextEncoder().encode(`version-${v.versionId}`).buffer;
      },
      restoreVersion: async (_v: FileVersion, fid: string) => { calls.restored.push(fid); },
      downloadFile: async (path: string) => {
        calls.downloaded.push(path);
        return new TextEncoder().encode('restored body').buffer;
      },
    } as unknown as IWebDAVClient;
    const service = new VersionService({
      localAdapter: {
        stat: async () => ({ size: 13, mtime: 777 }),
        atomicWriteBinary: async (p: string) => { calls.wrote.push(p); },
      } as never,
      stateDB: {
        getFile: () => tracked,
        setFile: (f: FileState) => { calls.setFile = f; },
        save: async () => { calls.saves++; },
      } as never,
      isTextEligible: () => true,
    });
    return { service, client, calls };
  }

  const tracked = (remoteFileId: string | null): FileState => ({
    path: 'note.md', localHash: 'h', remoteId: 'r', idType: 'etag', size: 1, mtime: 1,
    remoteFileId, isConflicted: false,
  });

  it('lists versions by the file id the state DB recorded', async () => {
    const { service, client, calls } = build(tracked('fid-7'));
    expect(await service.listVersions(client, NEXTCLOUD, 'note.md')).toEqual([version]);
    expect(calls.listed).toEqual(['fid-7']);
  });

  it('adds a synthetic Current entry when the live file is not present in retained versions', async () => {
    const { service, client } = build(tracked('fid-7'));
    const retained: FileVersion = {
      versionId: '100', href: '/v/100', lastModified: 100_000, size: 3, author: 'alice',
    };
    client.listVersions = async () => [retained];
    client.statFile = async () => ({
      path: 'note.md',
      fileId: 'fid-7',
      checksum: null,
      size: 7,
      lastModified: 200_000,
      etag: '"current-etag"',
    });

    const listed = await service.listVersions(client, NEXTCLOUD, 'note.md');

    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({
      versionId: 'current-200',
      lastModified: 200_000,
      size: 7,
      etag: '"current-etag"',
      isCurrent: true,
    });
    expect(listed[1]).toMatchObject({ versionId: '100', isCurrent: false });
  });

  it('adds a historical anchor when restored Current has an older mtime than retained history', async () => {
    const { service, client } = build(tracked('fid-7'));
    client.listVersions = async () => [
      { versionId: '300', href: '/v/300', lastModified: 300_000, size: 9, author: 'andi' },
      { versionId: '200', href: '/v/200', lastModified: 200_000, size: 7, author: 'andi' },
    ];
    client.statFile = async () => ({
      path: 'note.md',
      fileId: 'fid-7',
      checksum: null,
      size: 5,
      lastModified: 100_000,
      etag: '"restored-current"',
    });

    const listed = await service.listVersions(client, NEXTCLOUD, 'note.md');
    const current = listed.find((v) => v.isCurrent)!;
    const historicalAnchor = listed.find((v) => v.isCurrentRevisionAnchor)!;

    expect(current).toMatchObject({
      versionId: 'current-100',
      lastModified: 100_000,
      isCurrent: true,
    });
    expect(historicalAnchor).toMatchObject({
      versionId: 'current-anchor-100',
      lastModified: 100_000,
      isCurrent: false,
      isCurrentRevisionAnchor: true,
    });
  });

  it('refuses on a non-Nextcloud server', async () => {
    const { service, client } = build(tracked('fid-7'));
    await expect(service.listVersions(client, PLAIN, 'note.md')).rejects.toThrow(FeatureUnsupportedError);
  });

  it('refuses for a file the state DB has never seen', async () => {
    // Versions are addressed by fileId, so an untracked file has no history to show.
    const { service, client } = build(undefined);
    await expect(service.listVersions(client, NEXTCLOUD, 'note.md')).rejects.toThrow(FeatureUnsupportedError);
  });

  it('refuses for a tracked file with no remote id yet', async () => {
    const { service, client } = build(tracked(null));
    await expect(service.listVersions(client, NEXTCLOUD, 'note.md')).rejects.toThrow(FeatureUnsupportedError);
  });

  it('compares two retained versions through the same file-id version API', async () => {
    const { service, client, calls } = build(tracked('fid-7'));
    const before: FileVersion = {
      versionId: 'v1', href: '/v/v1', lastModified: 1, size: 1,
    };
    const after: FileVersion = {
      versionId: 'v2', href: '/v/v2', lastModified: 2, size: 1,
    };

    const result = await service.compareVersions(client, NEXTCLOUD, 'note.md', before, after);

    expect(result.beforeText).toBe('version-v1');
    expect(result.afterText).toBe('version-v2');
    expect(calls.fetchedVersions).toEqual(['fid-7:v1', 'fid-7:v2']);
    expect(calls.downloaded).toEqual([]);
  });

  it('uses the current file endpoint when the newer comparison side is current', async () => {
    const { service, client, calls } = build(tracked('fid-7'));
    const before: FileVersion = {
      versionId: 'v1', href: '/v/v1', lastModified: 1, size: 1,
    };
    const current: FileVersion = {
      versionId: 'current', href: '', lastModified: 2, size: 1, isCurrent: true,
    };

    const result = await service.compareVersions(client, NEXTCLOUD, 'note.md', before, current);

    expect(result.beforeText).toBe('version-v1');
    expect(result.afterText).toBe('restored body');
    expect(calls.fetchedVersions).toEqual(['fid-7:v1']);
    expect(calls.downloaded).toEqual(['note.md']);
  });

  it('reads retained and current version bodies through the correct endpoints', async () => {
    const { service, client, calls } = build(tracked('fid-7'));
    const historical: FileVersion = {
      versionId: 'v1', href: '/v/v1', lastModified: 1, size: 1,
    };
    const current: FileVersion = {
      versionId: 'current', href: '', lastModified: 2, size: 1, isCurrent: true,
    };

    await expect(service.readVersionText(client, NEXTCLOUD, 'note.md', historical))
      .resolves.toBe('version-v1');
    await expect(service.readVersionText(client, NEXTCLOUD, 'note.md', current))
      .resolves.toBe('restored body');

    expect(calls.fetchedVersions).toEqual(['fid-7:v1']);
    expect(calls.downloaded).toEqual(['note.md']);
  });

  it('builds historical line history only up to the selected retained version', async () => {
    const { service, client, calls } = build(tracked('fid-7'));
    const v1: FileVersion = { versionId: 'v1', href: '/v/v1', lastModified: 1, size: 1 };
    const v2: FileVersion = { versionId: 'v2', href: '/v/v2', lastModified: 2, size: 1 };
    const current: FileVersion = {
      versionId: 'current', href: '', lastModified: 3, size: 1, isCurrent: true,
    };

    await service.lineHistory(client, NEXTCLOUD, 'note.md', [current, v2, v1], v2);

    expect(calls.fetchedVersions).toEqual(['fid-7:v1', 'fid-7:v2']);
    expect(calls.downloaded).toEqual([]);
  });

  it('treats Current as the final line-history state even when its mtime is older', async () => {
    const { service, client, calls } = build(tracked('fid-7'));
    const v1: FileVersion = { versionId: 'v1', href: '/v/v1', lastModified: 10, size: 1 };
    const v2: FileVersion = { versionId: 'v2', href: '/v/v2', lastModified: 20, size: 1 };
    const v3: FileVersion = { versionId: 'v3', href: '/v/v3', lastModified: 30, size: 1 };
    const current: FileVersion = {
      versionId: 'current-old-mtime', href: '', lastModified: 10, size: 1, isCurrent: true,
    };

    await service.lineHistory(client, NEXTCLOUD, 'note.md', [current, v3, v1, v2], current);

    expect(calls.fetchedVersions).toEqual(['fid-7:v1', 'fid-7:v2', 'fid-7:v3']);
    expect(calls.downloaded).toEqual(['note.md']);
  });

  it('uses the restored Current anchor as provenance before a later historical target', async () => {
    const { service, client, calls } = build(tracked('fid-7'));
    const restoredAnchor: FileVersion = {
      versionId: 'current-anchor-100',
      href: '',
      lastModified: 100,
      size: 1,
      isCurrentRevisionAnchor: true,
    };
    const later: FileVersion = {
      versionId: 'v2',
      href: '/v/v2',
      lastModified: 200,
      size: 1,
    };
    const current: FileVersion = {
      versionId: 'current-100',
      href: '',
      lastModified: 100,
      size: 1,
      isCurrent: true,
    };

    client.downloadFile = async (path: string) => {
      calls.downloaded.push(path);
      return new TextEncoder().encode('base\nold line').buffer;
    };
    client.getVersionContent = async (v: FileVersion, fid: string) => {
      calls.fetchedVersions.push(`${fid}:${v.versionId}`);
      return new TextEncoder().encode('base\nold line\nnew line').buffer;
    };

    const result = await service.lineHistory(
      client,
      NEXTCLOUD,
      'note.md',
      [current, later, restoredAnchor],
      later,
    );

    expect(result.lines.map((line) => [line.text, line.version.versionId])).toEqual([
      ['base', 'current-anchor-100'],
      ['old line', 'current-anchor-100'],
      ['new line', 'v2'],
    ]);
    expect(calls.downloaded).toEqual(['note.md']);
    expect(calls.fetchedVersions).toEqual(['fid-7:v2']);
  });

  it('stops Current provenance at the matching restored historical state', async () => {
    const { service, client } = build(tracked('fid-7'));
    const restoredAnchor: FileVersion = {
      versionId: 'current-anchor-100', href: '', lastModified: 100, size: 1,
      isCurrentRevisionAnchor: true,
    };
    const later: FileVersion = {
      versionId: 'v2', href: '/v/v2', lastModified: 200, size: 1,
    };
    const current: FileVersion = {
      versionId: 'current-100', href: '', lastModified: 100, size: 1, isCurrent: true,
    };

    client.downloadFile = async () => new TextEncoder().encode('base\nold line').buffer;
    client.getVersionContent = async () =>
      new TextEncoder().encode('base\nold line\nnew line').buffer;

    const result = await service.lineHistory(
      client,
      NEXTCLOUD,
      'note.md',
      [current, later, restoredAnchor],
      current,
    );

    expect(result.lines.map((line) => line.text)).toEqual(['base', 'old line']);
    expect(result.lines.every((line) => line.version.isCurrentRevisionAnchor)).toBe(true);
  });

  it('restores on the server, applies the result locally, then converges the state DB', async () => {
    const { service, client, calls } = build(tracked('fid-7'));
    await service.restoreVersion(client, NEXTCLOUD, 'note.md', version);
    expect(calls.restored).toEqual(['fid-7']);
    expect(calls.wrote).toEqual(['note.md']);
    expect(calls.setFile).toMatchObject({
      remoteFileId: 'fid-7', idType: 'sha256', isConflicted: false, localMtime: 777,
    });
    expect(calls.setFile?.localHash).toBe(calls.setFile?.remoteId); // both sides hold this body
    expect(calls.saves).toBe(1);
  });

  it('applies the same two preconditions to a restore', async () => {
    const plain = build(tracked('fid-7'));
    await expect(plain.service.restoreVersion(plain.client, PLAIN, 'note.md', version)).rejects.toThrow(FeatureUnsupportedError);
    const untracked = build(undefined);
    await expect(untracked.service.restoreVersion(untracked.client, NEXTCLOUD, 'note.md', version)).rejects.toThrow(FeatureUnsupportedError);
    expect(untracked.calls.restored).toEqual([]); // nothing touched the server
  });
});

// [SPEC:DSD-1] [SPEC:DSD-2] [SPEC:DSD-3] [SPEC:DSD-4] Declarative settings definitions.
//
// The settings tab is an adapter over `getSettingDefinitions()` (Obsidian 1.13.0+), because the search
// index is built ONLY from that array.
//
// The real hazard is a `key` typo that silently detaches a row from its stored value: the row renders,
// the user changes it, and nothing is persisted. So every control's `key` is checked against
// DEFAULT_SETTINGS, both directions.
//
// Coverage is deliberately asymmetric: `control` rows carry a `key`, so key/type integrity IS checkable
// (about 14 rows); `render` rows carry no key (about 10 rows: the numeric input beside each slider, the
// SecretComponent for the app password), so only presence, order and search visibility are asserted.
//
// Row counts are hardcoded, not derived: a derivation that silently skips a row would produce a green
// test asserting the wrong shape.
import type { SettingDefinitionItem, SettingDefinitionGroup } from 'obsidian';
import {
  buildSettingDefinitions,
  RENDER_ONLY_ROWS,
  UI_LESS_SETTING_KEYS,
  type SettingDefinitionsHost,
} from '../../../src/settings/settingDefinitions';
import { DEFAULT_SETTINGS, type DavSyncSettings } from '../../../src/types';

// Expected static structure: section headings and the rows each holds.
const BASELINE: { heading: string | null; rows: string[] }[] = [
  { heading: null, rows: ['Sync now'] },
  {
    heading: 'Nextcloud',
    rows: [
      'Server URL',
      'Log in via browser (Nextcloud) — recommended',
      'Username',
      'App password',
      'Sync folder',
      'Sync target (WebDAV)',
      'Use Nextcloud client push',
      'Client Push URL override',
      'Client Push status',
    ],
  },
  {
    heading: 'Sync',
    rows: [
      'Startup sync delay (seconds)',
      'Sync interval (minutes)',
      'Network timeout (seconds)',
      'Network concurrency',
      'Sync on Wi-Fi only',
      'Sync on file change',
      'Maximum file size (MB)',
    ],
  },
  {
    heading: 'Conflict resolution',
    rows: [
      'Auto merge file types',
      'Auto merge file strategy',
      'Other file strategy',
      'Frontmatter strategy',
      'Conflict strategy',
    ],
  },
  { heading: 'Excluded folders', rows: ['Excluded folders', 'Add excluded folder'] },
  { heading: 'Config folder (.obsidian)', rows: ['Sync config folder'] },
  { heading: 'Debug', rows: ['Enable logging (troubleshooting)'] },
  { heading: 'Advanced (use with caution)', rows: ['Mass-delete safety limit'] },
  { heading: 'Maintenance', rows: ['Reset vault index', 'Mirror from remote', 'Last session summary'] },
];

const STATIC_ROW_COUNT = BASELINE.reduce((n, s) => n + s.rows.length, 0); // 30

function makeHost(over: Partial<SettingDefinitionsHost> = {}): SettingDefinitionsHost {
  return {
    settings: { ...DEFAULT_SETTINGS },
    isMobile: false,
    isIosApp: false,
    isSignedIn: true,
    configDir: '.obsidian',
    vaultName: 'TestVault',
    syncTargetUrl: () => 'https://example.invalid/dav/TestVault',
    clientPushStatusSummary: () => 'Disabled',
    runSyncNow: () => undefined,
    runRemoteMirror: () => undefined,
    resetVaultIndex: () => undefined,
    openSyncStatus: () => undefined,
    startLoginFlow: () => undefined,
    addExcludedFolder: () => undefined,
    removeExcludedFolder: () => undefined,
    openCommunityPluginPicker: jest.fn(),
    removeSyncedCommunityPlugin: jest.fn(),
    renderAppPassword: () => undefined,
    renderNumberSlider: () => undefined,
    renderReadOnly: () => undefined,
    renderNotice: () => undefined,
    renderExtensionList: () => undefined,
    renderAddExcludedFolder: () => undefined,
    ...over,
  };
}

const isGroup = (i: SettingDefinitionItem): i is SettingDefinitionGroup =>
  (i as SettingDefinitionGroup).type === 'group' || (i as SettingDefinitionGroup).type === 'list';

function flatten(items: SettingDefinitionItem[]): { heading: string | null; row: any }[] {
  const out: { heading: string | null; row: any }[] = [];
  for (const item of items) {
    if (isGroup(item)) {
      for (const child of item.items ?? []) out.push({ heading: item.heading ?? null, row: child });
    } else {
      out.push({ heading: null, row: item });
    }
  }
  return out;
}

const rowsOf = (items: SettingDefinitionItem[]) => flatten(items).map((f) => f.row);
const controlRows = (items: SettingDefinitionItem[]) => rowsOf(items).filter((r) => r.control);

// Rows that represent a setting. Banners, help paragraphs, dividers and the caution block are rows
// declaratively but are not counted in the baseline, so they are filtered out here.
const settingRowsIn = (items: SettingDefinitionItem[]) =>
  flatten(items).filter((f) => !RENDER_ONLY_ROWS.decorations.includes(f.row.name));

describe('[SPEC:DSD-1] structure matches the pre-migration baseline', () => {
  it('returns a non-empty array — an empty one would fall back to the deleted display()', () => {
    // `display()` is only called when getSettingDefinitions() returns empty (obsidian.d.ts:6633) and this tab
    // has none, so an empty return renders NOTHING.
    expect(buildSettingDefinitions(makeHost()).length).toBeGreaterThan(0);
  });

  it('has the same section headings, in the same order', () => {
    const items = buildSettingDefinitions(makeHost());
    // The first group carries no heading: the tab opens with "Sync now" above the first `setHeading()`.
    const headings = items.filter(isGroup).map((g) => g.heading).filter((h) => h !== undefined);
    expect(headings).toEqual(BASELINE.filter((s) => s.heading !== null).map((s) => s.heading));
  });

  it('has the same rows, in the same order, within each section', () => {
    const flat = settingRowsIn(buildSettingDefinitions(makeHost()));
    const expected = BASELINE.flatMap((s) => s.rows.map((r) => ({ heading: s.heading, name: r })));
    expect(flat.map((f) => ({ heading: f.heading, name: f.row.name }))).toEqual(expected);
  });

  it('[SPEC:DBG-1] keeps the Debug section a single toggle', () => {
    // The Device name / Log folder inputs were removed so every user converges on one path; this asserts
    // that guarantee.
    const debug = buildSettingDefinitions(makeHost())
      .filter(isGroup)
      .find((g) => g.heading === 'Debug')!;
    expect((debug.items ?? []).map((i: any) => i.name)).toEqual(['Enable logging (troubleshooting)']);
  });

  it('resolves the config-folder heading from the host, not a hardcoded ".obsidian"', () => {
    const items = buildSettingDefinitions(makeHost({ configDir: '.my-config' }));
    const headings = items.filter(isGroup).map((g) => g.heading);
    expect(headings).toContain('Config folder (.my-config)');
    expect(headings).not.toContain('Config folder (.obsidian)');
  });
});

describe('[SPEC:DSD-2] row count is dynamic, not a constant', () => {
  // Excluded folders render one row each (two more when config sync is on), so a fixed count would pass
  // while silently dropping every dynamic row.
  it('adds one row per excluded folder', () => {
    const none = settingRowsIn(buildSettingDefinitions(makeHost())).length;
    const three = settingRowsIn(
      buildSettingDefinitions(
        makeHost({ settings: { ...DEFAULT_SETTINGS, excludedFolders: ['a', 'b', 'c'] } }),
      ),
    ).length;
    expect(none).toBe(STATIC_ROW_COUNT);
    expect(three).toBe(STATIC_ROW_COUNT + 3);
  });

  // The community-plugins warning is a render-only decoration, but it is a row the user sees, so it counts here.
  const countRows = (settings: Partial<DavSyncSettings>): number =>
    flatten(buildSettingDefinitions(makeHost({ settings: { ...DEFAULT_SETTINGS, ...settings } }))).filter(
      (f) => f.row.name === 'Community plugins warning' || !RENDER_ONLY_ROWS.decorations.includes(f.row.name),
    ).length;
  const expected = (s: Partial<DavSyncSettings>): number =>
    STATIC_ROW_COUNT + (s.excludedFolders?.length ?? 0) + (s.syncConfigFolder ? 4 + (s.syncedCommunityPlugins?.length ?? 0) : 0);

  it.each([
    { syncConfigFolder: false },
    { syncConfigFolder: true, syncedCommunityPlugins: [] },
    { syncConfigFolder: true, syncedCommunityPlugins: ['a', 'b'] },
    { syncConfigFolder: true, syncedCommunityPlugins: ['a', 'b'], excludedFolders: ['x', 'y', 'z'] },
  ])('counts 27 + excluded + (master ? 4 + plugins : 0) rows for %j', (s) => {
    expect(countRows(s)).toBe(expected(s));
  });

  it('adds no community plugin row while the master toggle is off, even when the list is set', () => {
    const s = { syncConfigFolder: false, syncedCommunityPlugins: ['a', 'b'] };
    expect(countRows(s)).toBe(STATIC_ROW_COUNT);
    const names = rowsOf(buildSettingDefinitions(makeHost({ settings: { ...DEFAULT_SETTINGS, ...s } }))).map((r) => r.name);
    expect(names).not.toContain('Choose plugins…');
    expect(names).not.toContain('Community plugins warning');
  });
});

describe('[SPEC:CPS-10] community plugin rows', () => {
  const master = { ...DEFAULT_SETTINGS, syncConfigFolder: true, syncedCommunityPlugins: ['a', 'b'] };
  const configRows = (host: SettingDefinitionsHost): any[] =>
    flatten(buildSettingDefinitions(host)).filter((f) => f.heading === 'Config folder (.obsidian)').map((f) => f.row);

  it('orders the rows after the categories: warning, one row per plugin, then Choose plugins…', () => {
    const names = configRows(makeHost({ settings: master })).map((r) => r.name);
    const w = names.indexOf('Community plugins warning');
    expect(w).toBeGreaterThan(names.indexOf('Sync config folder'));
    expect(names.slice(w)).toEqual(['Community plugins warning', 'a', 'b', 'Choose plugins…']);
    expect(names.slice(0, w).length).toBe(3); // master toggle + two categories
  });

  it('gives every community plugin row a non-empty desc', () => {
    const rows = configRows(makeHost({ settings: master }));
    for (const r of rows.slice(rows.findIndex((x) => x.name === 'Community plugins warning'))) {
      expect(typeof r.desc).toBe('string');
      expect(r.desc.length).toBeGreaterThan(0);
    }
  });

  it('removes a plugin from the list when its row is clicked', () => {
    const host = makeHost({ settings: master });
    configRows(host).find((r) => r.name === 'a').action();
    expect(host.removeSyncedCommunityPlugin).toHaveBeenCalledWith('a');
    expect(host.openCommunityPluginPicker).not.toHaveBeenCalled();
  });

  it('opens the picker from Choose plugins… with the documented aliases', () => {
    const host = makeHost({ settings: master });
    const row = configRows(host).find((r) => r.name === 'Choose plugins…');
    expect(row.aliases).toEqual(['plugins', 'community plugins', 'plugin sync', 'add plugin']);
    row.action();
    expect(host.openCommunityPluginPicker).toHaveBeenCalledTimes(1);
  });

  it('describes the plugin rows and the two reworded parent rows', () => {
    const rows = configRows(makeHost({ settings: master }));
    expect(rows.find((r) => r.name === 'a').desc).toBe('Synced. Click to stop syncing this plugin on this device.');
    expect(rows.find((r) => r.name === 'Choose plugins…').desc).toBe(
      'Pick community plugins to sync from the ones installed on this device or on the server. Only manifest.json, main.js, styles.css and data.json directly in each plugin folder sync; ' +
      'other files stay device-local. Each device has its own list, and a plugin syncs only between devices that both list it. ' +
      'Turning a plugin on or off (community-plugins.json) is never synced.',
    );
    expect(rows.find((r) => r.name === 'Sync config folder').desc).toBe(
      'Opt in to syncing parts of the .obsidian config folder across devices. Off by default — only notes and other vault files sync. Community plugins sync only when you pick them below; everything else in the plugins folder stays device-local. A synced change to core-plugin settings may need an Obsidian restart to take effect on the other device.',
    );
    const excluded = flatten(buildSettingDefinitions(makeHost())).find((f) => f.row.name === 'Excluded folders')!.row;
    expect(excluded.desc).toBe(
      'Folders that are never synced — neither uploaded nor downloaded. Matched by folder prefix at a folder boundary, additive on top of .git, .trash, this plugin\'s own folder, and community plugins you have not picked, which are already excluded automatically.',
    );
  });
});

describe('[SPEC:DSD-3] every control key is real, unique and correctly typed', () => {
  it('binds every control to a key that exists in DEFAULT_SETTINGS', () => {
    const unknown = controlRows(buildSettingDefinitions(makeHost()))
      .map((r) => (r.control.key as string).split('.')[0])
      .filter((k) => !(k in DEFAULT_SETTINGS));
    // A key that is not in DEFAULT_SETTINGS renders fine and persists nothing.
    expect(unknown).toEqual([]);
  });

  it('never binds two rows to the same key', () => {
    const keys = controlRows(buildSettingDefinitions(makeHost({
      settings: { ...DEFAULT_SETTINGS, syncConfigFolder: true },
    }))).map((r) => r.control.key as string);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('matches each control type to the stored value type', () => {
    const expectedType: Record<string, string[]> = {
      toggle: ['boolean'],
      slider: ['number'],
      number: ['number'],
      text: ['string'],
      textarea: ['string'],
      dropdown: ['string'],
      folder: ['string'],
      file: ['string'],
      color: ['string'],
    };
    const mismatches: string[] = [];
    for (const row of controlRows(buildSettingDefinitions(makeHost({
      settings: { ...DEFAULT_SETTINGS, syncConfigFolder: true },
    })))) {
      const key = row.control.key as string;
      // Dotted keys address a nested value (configSync.bookmarks); resolve the path.
      const stored = key.split('.').reduce<unknown>(
        (o, seg) => (o == null ? undefined : (o as Record<string, unknown>)[seg]),
        DEFAULT_SETTINGS as unknown,
      );
      // configSync holds a nested object; its category rows bind through their own keys.
      if (stored === undefined || stored === null) continue;
      const allowed = expectedType[row.control.type as string];
      if (allowed && !allowed.includes(typeof stored)) {
        mismatches.push(`${key}: control=${row.control.type} stored=${typeof stored}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('surfaces every setting that should have a UI, and declares the ones that should not', () => {
    // The reverse direction. Without it, a row can be dropped during the migration and no test
    // notices — the settings file still holds the value, but nothing can change it any more.
    const bound = new Set(
      controlRows(buildSettingDefinitions(makeHost({
        settings: { ...DEFAULT_SETTINGS, syncConfigFolder: true },
      }))).map((r) => (r.control.key as string).split('.')[0]),
    );
    const missing = Object.keys(DEFAULT_SETTINGS).filter(
      (k) => !bound.has(k) && !UI_LESS_SETTING_KEYS.includes(k as keyof DavSyncSettings)
        && !RENDER_ONLY_ROWS.settingKeys.includes(k as keyof DavSyncSettings),
    );
    expect(missing).toEqual([]);
  });

  it('keeps the ui-less and render-only key lists honest (no stale entries)', () => {
    const all = Object.keys(DEFAULT_SETTINGS);
    const stale = [...UI_LESS_SETTING_KEYS, ...RENDER_ONLY_ROWS.settingKeys].filter(
      (k) => !all.includes(k as string),
    );
    // An explicit allow-list rots silently unless something checks it against reality.
    expect(stale).toEqual([]);
  });
});

describe('[SPEC:DSD-4] search visibility is precise', () => {
  it('excludes decorations from search, and only decorations', () => {
    const items = buildSettingDefinitions(makeHost());
    const notSearchable = rowsOf(items).filter((r) => r.searchable === false).map((r) => r.name);
    // Decorations are rows that carry no setting: banners, help text, dividers, warnings. A default
    // host has no excluded folders, so no list entries are present to widen this set.
    const expected = RENDER_ONLY_ROWS.decorations.filter((d) =>
      rowsOf(items).some((r) => r.name === d));
    expect(notSearchable.sort()).toEqual([...expected].sort());
  });

  it('leaves every real setting searchable', () => {
    const baselineNames = new Set(BASELINE.flatMap((s) => s.rows));
    const hidden = rowsOf(buildSettingDefinitions(makeHost()))
      .filter((r) => r.searchable === false && baselineNames.has(r.name));
    // SC-001: a stray searchable:false silently undoes search discoverability, the point of the tab.
    expect(hidden.map((r) => r.name)).toEqual([]);
  });

  it('attaches aliases only to real settings', () => {
    const baselineNames = new Set(BASELINE.flatMap((s) => s.rows));
    const aliased = rowsOf(buildSettingDefinitions(makeHost())).filter((r) => r.aliases?.length);
    expect(aliased.length).toBeGreaterThanOrEqual(10);
    expect(aliased.filter((r) => !baselineNames.has(r.name)).map((r) => r.name)).toEqual([]);
  });

  it('gives every non-heading row a description (the old tooltip coverage guarantee, moved)', () => {
    // Every row carries its supplementary help in `desc`, where mobile can read it (there are no tooltips).
    const undocumented = rowsOf(buildSettingDefinitions(makeHost()))
      .filter((r) => !r.desc)
      .map((r) => r.name);
    expect(undocumented).toEqual([]);
  });
});

describe('[SPEC:DSD-5] predicates reflect platform and sign-in state', () => {
  const rowNamed = (host: SettingDefinitionsHost, name: string) =>
    rowsOf(buildSettingDefinitions(host)).find((r) => r.name === name)!;

  const isDisabled = (row: any): boolean => {
    const d = row.control?.disabled ?? row.disabled;
    return typeof d === 'function' ? !!d() : !!d;
  };

  it('disables "Sync on Wi-Fi only" on iOS only', () => {
    expect(isDisabled(rowNamed(makeHost({ isIosApp: true, isMobile: true }), 'Sync on Wi-Fi only'))).toBe(true);
    expect(isDisabled(rowNamed(makeHost({ isIosApp: false }), 'Sync on Wi-Fi only'))).toBe(false);
  });

  it('[SPEC:MWM-1] enables "Sync on file change" on Android but keeps it disabled on iOS', () => {
    expect(isDisabled(rowNamed(makeHost({ isMobile: true, isIosApp: false }), 'Sync on file change'))).toBe(false);
    expect(isDisabled(rowNamed(makeHost({ isMobile: true, isIosApp: true }), 'Sync on file change'))).toBe(true);
    expect(isDisabled(rowNamed(makeHost({ isMobile: false, isIosApp: false }), 'Sync on file change'))).toBe(false);
  });

  it('describes Android watch as foreground, best-effort and Wi-Fi-only aware', () => {
    const row = rowNamed(makeHost({ isMobile: true, isIosApp: false }), 'Sync on file change');
    expect(row.desc).toContain('foreground');
    expect(row.desc).toContain('best-effort');
    expect(row.desc).toContain('Wi-Fi-only');
    expect(row.desc).toContain('Off by default');
  });

  it('enables the Client Push URL override only while Client Push is enabled', () => {
    expect(isDisabled(rowNamed(makeHost({ settings: { ...DEFAULT_SETTINGS, useClientPush: false } }), 'Client Push URL override'))).toBe(true);
    expect(isDisabled(rowNamed(makeHost({ settings: { ...DEFAULT_SETTINGS, useClientPush: true } }), 'Client Push URL override'))).toBe(false);
  });

  it('disables "Sync now" until the credentials are complete', () => {
    expect(isDisabled(rowNamed(makeHost({ isSignedIn: false }), 'Sync now'))).toBe(true);
    expect(isDisabled(rowNamed(makeHost({ isSignedIn: true }), 'Sync now'))).toBe(false);
  });

  it('shows the not-signed-in banner only while signed out', () => {
    const visible = (host: SettingDefinitionsHost): boolean => {
      const row = rowsOf(buildSettingDefinitions(host)).find((r) => r.name === RENDER_ONLY_ROWS.authBanner);
      if (!row) return false;
      return typeof row.visible === 'function' ? !!row.visible() : row.visible !== false;
    };
    expect(visible(makeHost({ isSignedIn: false }))).toBe(true);
    expect(visible(makeHost({ isSignedIn: true }))).toBe(false);
  });
});

describe('[SPEC:FR-007] Server URL row always shows the full-endpoint guidance', () => {
  // A host-only URL fails with HTTP 405. The desc is always visible, so it is the one place a mobile
  // user can read the expected shape before typing.
  it('names the full WebDAV endpoint, the optional subfolder and the 405 on a host-only URL', () => {
    const row = rowsOf(buildSettingDefinitions(makeHost())).find((r) => r.name === 'Server URL');
    const desc = String(row?.desc);
    expect(desc).toContain('/remote.php/dav/files/<user>/');
    expect(desc).toContain('HTTP 405');
    expect(desc).toContain('subfolder');
  });
});

describe('Server compatibility notice ([SPEC:VSN-2])', () => {
  // GitHub issue #54: the banner's `visible` never consulted isSupportedNextcloudVersion(), so it
  // showed for every detected server, including ones at or above MIN_NEXTCLOUD_VERSION.
  const serverCompatibilityVisible = (host: SettingDefinitionsHost): boolean => {
    const row = rowsOf(buildSettingDefinitions(host)).find((r) => r.name === 'Server compatibility');
    if (!row) return false;
    return typeof row.visible === 'function' ? !!row.visible() : row.visible !== false;
  };

  it.each(['34.0.3', '33', '40.1.0'])(
    '[VSN-2] hides the banner for a server at or above MIN_NEXTCLOUD_VERSION (%s)',
    (version) => {
      const host = makeHost({ settings: { ...DEFAULT_SETTINGS, lastKnownServerVersion: version } });
      expect(serverCompatibilityVisible(host)).toBe(false);
    },
  );

  it.each(['32.0.5', '25'])(
    '[SPEC:VSN-1] shows the banner, with the detected version in the text, below MIN_NEXTCLOUD_VERSION (%s)',
    (version) => {
      const host = makeHost({ settings: { ...DEFAULT_SETTINGS, lastKnownServerVersion: version } });
      expect(serverCompatibilityVisible(host)).toBe(true);
      const row = rowsOf(buildSettingDefinitions(host)).find((r) => r.name === 'Server compatibility')!;
      expect(row.desc).toContain(version);
    },
  );

  it('[SPEC:VSN-3] never builds a "Server compatibility" row when no server version has been detected yet', () => {
    const host = makeHost({ settings: { ...DEFAULT_SETTINGS, lastKnownServerVersion: '' } });
    const row = rowsOf(buildSettingDefinitions(host)).find((r) => r.name === 'Server compatibility');
    expect(row).toBeUndefined();
  });
});

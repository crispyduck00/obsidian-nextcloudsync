import type { ConfigSyncCategories } from '../../types';

/** The settings that decide which files the sync scope covers (docs/spec.md §8a.5). */
export interface SyncScopeInput {
  syncConfigFolder: boolean;
  configSync: ConfigSyncCategories;
  excludedFolders: readonly string[];
  syncedCommunityPlugins: readonly string[];
  maxFileSizeMB: number;
}

/**
 * Order-independent fingerprint of the sync scope. When it changes, the root-ETag
 * short-circuit must be skipped once. With the config folder off, the config
 * categories and the plugin list cannot affect the scope, so they are left out.
 */
export function computeSyncScopeFingerprint(input: SyncScopeInput): string {
  const { syncConfigFolder, configSync, excludedFolders, syncedCommunityPlugins, maxFileSizeMB } = input;
  return JSON.stringify([
    // Bump when an upgrade needs a real scan (v3: size-skipped remote entries, docs/spec.md §8a.5).
    'scope-v3',
    syncConfigFolder,
    syncConfigFolder ? Object.entries(configSync).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : [],
    [...excludedFolders].sort(),
    syncConfigFolder ? [...syncedCommunityPlugins].sort() : [],
    maxFileSizeMB,
  ]);
}

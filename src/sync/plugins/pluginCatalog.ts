// Pure catalog logic for community plugin bundles: manifest parsing and the per-plugin ignore rules (docs/spec.md §7).
import type { FileState, RemoteFileInfo } from '../../types';
import coerce from 'semver/functions/coerce';
import { isOverFileSizeLimit } from '../../util/limits';
import { compareSemver } from '../../util/version';
import { checksumProvesIdentical } from '../identity/contentIdentity';
import { remoteRevisionChanged } from '../remoteIdentity';

export type PluginIgnoreReason =
  | 'desktop-only'
  | 'manifest-unreadable'
  | 'too-large'
  | 'min-app-version'
  | 'remote-manifest-unavailable'
  | 'local-manifest-unavailable';

export interface PluginCatalog {
  readonly included: ReadonlySet<string>;
  readonly ignored: ReadonlyMap<string, PluginIgnoreReason>;
  readonly enabled: ReadonlySet<string> | 'unknown';
}

export interface PluginManifestInfo {
  name: string | null;
  version: string | null;
  minAppVersion: string | null;
  isDesktopOnly: boolean;
}

export type ManifestRead = PluginManifestInfo | 'absent' | 'unreadable';
export type RemoteManifestRead = ManifestRead | 'not-fetched' | 'fetch-failed';

export interface CatalogEntryInput {
  local: ManifestRead;
  remote: RemoteManifestRead;
  // Sizes in bytes of the code files, from both the local stat and the remote listing.
  codeFileSizes: readonly number[];
  isMobile: boolean;
  obsidianVersion: string;
  maxFileSizeMB: number;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function parsePluginManifest(raw: string): PluginManifestInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  return {
    name: stringOrNull(obj.name),
    version: stringOrNull(obj.version),
    minAppVersion: stringOrNull(obj.minAppVersion),
    isDesktopOnly: obj.isDesktopOnly === true,
  };
}

export function parseCommunityPluginsJson(raw: string | null): ReadonlySet<string> | 'unknown' {
  if (raw === null) return 'unknown';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unknown';
  }
  if (!Array.isArray(parsed)) return 'unknown';
  return new Set(parsed.filter((v): v is string => typeof v === 'string'));
}

function readableManifests(input: CatalogEntryInput): PluginManifestInfo[] {
  return [input.local, input.remote].filter(
    (m): m is PluginManifestInfo => typeof m === 'object',
  );
}

function evaluateMobile(input: CatalogEntryInput, manifests: PluginManifestInfo[]): PluginIgnoreReason | null {
  if (manifests.some((m) => m.isDesktopOnly)) return 'desktop-only';
  if (manifests.length === 0 && (input.local === 'unreadable' || input.remote === 'unreadable')) {
    return 'manifest-unreadable';
  }
  return null;
}

export function evaluatePluginCatalogEntry(input: CatalogEntryInput): PluginIgnoreReason | null {
  if (input.remote === 'fetch-failed') return 'remote-manifest-unavailable';
  if (input.codeFileSizes.some((size) => isOverFileSizeLimit(size, input.maxFileSizeMB))) return 'too-large';
  const manifests = readableManifests(input);
  if (input.isMobile) {
    const mobileReason = evaluateMobile(input, manifests);
    if (mobileReason !== null) return mobileReason;
  }
  const needsNewerApp = manifests.some((m) => requiresNewerApp(m.minAppVersion, input.obsidianVersion));
  return needsNewerApp ? 'min-app-version' : null;
}

// Missing minor/patch parts count as 0 ("1.10" is 1.10.0); a value that does not coerce never ignores the plugin.
function requiresNewerApp(minAppVersion: string | null, obsidianVersion: string): boolean {
  if (minAppVersion === null) return false;
  const required = coerce(minAppVersion);
  return required !== null && compareSemver(required.version, obsidianVersion) > 0;
}

export function shouldFetchRemoteManifest(input: {
  remoteManifest: RemoteFileInfo | null;
  localHash: string | null;
  base: FileState | null;
}): boolean {
  const { remoteManifest, localHash, base } = input;
  if (remoteManifest === null) return false;
  if (localHash !== null && checksumProvesIdentical(remoteManifest, localHash)) return false;
  return localHash === null || remoteRevisionChanged(remoteManifest, base ?? undefined);
}

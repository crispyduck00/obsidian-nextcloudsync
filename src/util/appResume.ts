/**
 * Syncing when the app comes back to the foreground (upstream change, GitHub discussion #44).
 *
 * Mobile has no reliable periodic background sync. Android may now opt into foreground-only watch,
 * but that accelerates local changes while the app is alive; it deliberately does not promise
 * background execution and cannot replace an authoritative catch-up after a suspension. Without
 * Client Push, an Obsidian left in the background still needs this trigger to notice another
 * device's remote changes.
 *
 * Coming back to the foreground is the one moment when the app is provably running and the user is
 * provably looking at it, which makes it the only trigger that does not depend on background
 * execution working. It is registered on every platform rather than only on mobile: a desktop machine
 * that slept has the same hole (its interval timer did not tick while it was asleep), and not
 * branching on the platform is the simpler shape.
 *
 * The risk is entirely in the other direction — a trigger that fires on every app switch would spend
 * the user's data and battery for nothing — so the cooldown below is the part that matters.
 */

// Minimum gap between syncs for this trigger. Deliberately not a setting: short enough that a real
// "was away, came back" case syncs, long enough that glancing at a notification costs nothing.
export const RESUME_SYNC_COOLDOWN_MS = 5 * 60 * 1000;

// Both events are kept: `visibilitychange` fires on mobile resume, `focus` on desktop (issue #34);
// the cooldown absorbs the extra desktop firings. The guard exists because jest's `node` environment
// has neither global.
export function onAppResume(cb: () => void): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => undefined;
  const onVisibility = (): void => { if (document.visibilityState === 'visible') cb(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', cb);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', cb);
  };
}

// `lastSyncTime` is stamped by every sync whatever started it, so a resume right after the startup
// sync is skipped without extra bookkeeping. `0` (never synced) counts as long ago; a future
// timestamp (clock change) counts as recent so a bad clock cannot make every resume sync.
export function shouldSyncOnResume(now: number, lastSyncTime: number, cooldownMs: number): boolean {
  const elapsed = now - lastSyncTime;
  if (elapsed < 0) return false;
  return elapsed >= cooldownMs;
}

export interface ResumeSyncDeps {
  // null/undefined while the settings are incomplete or the engine is still starting.
  getEngine: () => { syncManual: () => Promise<void> } | null | undefined;
  getLastSyncTime: () => number;
  now?: () => number;
  log: (message: string) => void;
  cooldownMs?: number;
  // Reads `startupSyncDelaySeconds > 0`: turning startup sync off also turns resume sync off (issue #49).
  // A function so a setting flipped mid-session applies on the next resume; defaults to allowed.
  startupSyncEnabled?: () => boolean;
}

// Kept out of main.ts so it is testable without constructing a plugin. Silent by design: the user
// did not ask for this sync, so a missing engine is a no-op; outcomes go to the diagnostic log.
export function makeResumeSyncHandler(deps: ResumeSyncDeps): () => void {
  const now = deps.now ?? (() => Date.now());
  const cooldownMs = deps.cooldownMs ?? RESUME_SYNC_COOLDOWN_MS;
  return () => {
    const engine = deps.getEngine();
    if (!engine) return;
    if (deps.startupSyncEnabled && !deps.startupSyncEnabled()) {
      deps.log('resume: skipped — startup sync is off, so app-appearance syncs are off too');
      return;
    }
    if (!shouldSyncOnResume(now(), deps.getLastSyncTime(), cooldownMs)) {
      deps.log('resume: skipped — synced within the cooldown');
      return;
    }
    deps.log('resume: app returned to the foreground — syncing');
    void engine.syncManual();
  };
}

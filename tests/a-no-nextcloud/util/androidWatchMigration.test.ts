import { migrateAndroidWatchOptIn } from '../../../src/util/settingsMigration';
import { DEFAULT_SETTINGS, DavSyncSettings } from '../../../src/types';

describe('migrateAndroidWatchOptIn', () => {
  const settings = (): DavSyncSettings => ({ ...DEFAULT_SETTINGS });

  it('forces a formerly-inert persisted true off exactly once', () => {
    const s = settings();
    s.watchOnChangeEnabled = true;

    expect(migrateAndroidWatchOptIn({ mobileWatchMigrationVersion: undefined }, s)).toBe(true);
    expect(s.watchOnChangeEnabled).toBe(false);
    expect(s.mobileWatchMigrationVersion).toBe(1);
  });

  it('also records the migration when watch was already false', () => {
    const s = settings();
    s.watchOnChangeEnabled = false;

    expect(migrateAndroidWatchOptIn({}, s)).toBe(true);
    expect(s.watchOnChangeEnabled).toBe(false);
    expect(s.mobileWatchMigrationVersion).toBe(1);
  });

  it('preserves the user choice after the Android opt-in boundary was recorded', () => {
    const s = settings();
    s.watchOnChangeEnabled = true;
    s.mobileWatchMigrationVersion = 1;

    expect(migrateAndroidWatchOptIn({ mobileWatchMigrationVersion: 1 }, s)).toBe(false);
    expect(s.watchOnChangeEnabled).toBe(true);
    expect(s.mobileWatchMigrationVersion).toBe(1);
  });
});

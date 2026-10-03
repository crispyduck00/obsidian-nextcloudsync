import { isWatchModeActive } from '../../../src/util/settingsMigration';

// Android foreground watch is opt-in. Mobile first-run still defaults the persisted setting to false
// (mobileFirstRunDefaults.test.ts); this runtime policy decides only whether an already-enabled
// setting is allowed to fire on the current platform.
describe('[SPEC:G7-2] isWatchModeActive (mobile watch)', () => {
  it('is active on desktop when the setting is on', () => {
    expect(isWatchModeActive(true, false, false)).toBe(true);
  });

  it('is inactive on desktop when the setting is off', () => {
    expect(isWatchModeActive(false, false, false)).toBe(false);
  });

  it('is active on Android when the user explicitly enabled it', () => {
    expect(isWatchModeActive(true, true, false)).toBe(true);
  });

  it('stays inactive on Android while the default/off setting is false', () => {
    expect(isWatchModeActive(false, true, false)).toBe(false);
  });

  it('remains disabled on iOS even if a persisted setting says true', () => {
    expect(isWatchModeActive(true, true, true)).toBe(false);
  });

  it.each([
    [true, false, false, true],
    [false, false, false, false],
    [true, true, false, true],
    [false, true, false, false],
    [true, true, true, false],
    [false, true, true, false],
  ])(
    'enabled=%s isMobile=%s isIos=%s → %s',
    (enabled, isMobile, isIos, expected) => {
      expect(isWatchModeActive(
        enabled as boolean,
        isMobile as boolean,
        isIos as boolean,
      )).toBe(expected);
    },
  );
});

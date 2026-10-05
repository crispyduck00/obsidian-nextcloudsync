import type { Command, IconName } from 'obsidian';
import {
  CMD_VERSION_HISTORY,
  VERSION_HISTORY_ICON,
  VERSION_HISTORY_LABEL,
  registerVersionHistoryEntryPoints,
  VersionHistoryEntryPointHost,
} from '../../../src/ui/versionHistoryEntryPoints';

interface RibbonCall {
  icon: IconName;
  title: string;
  callback: (evt: MouseEvent) => unknown;
}

function makeFakeHost(): {
  host: VersionHistoryEntryPointHost;
  commands: Command[];
  ribbons: RibbonCall[];
  count: () => number;
} {
  const commands: Command[] = [];
  const ribbons: RibbonCall[] = [];
  let opens = 0;
  const host: VersionHistoryEntryPointHost = {
    addRibbonIcon(icon, title, callback) {
      ribbons.push({ icon, title, callback });
      return {} as HTMLElement;
    },
    addCommand(command) {
      commands.push(command);
      return command;
    },
    openVersionHistoryForActiveFile() {
      opens++;
    },
  };
  return { host, commands, ribbons, count: () => opens };
}

describe('Version history entry points', () => {
  it('registers one history ribbon action with a recognizable icon', () => {
    const { host, ribbons, count } = makeFakeHost();
    registerVersionHistoryEntryPoints(host);

    expect(ribbons).toHaveLength(1);
    expect(ribbons[0].icon).toBe(VERSION_HISTORY_ICON);
    expect(ribbons[0].icon).toBe('history');
    expect(ribbons[0].title).toBe(VERSION_HISTORY_LABEL);
    expect(ribbons[0].title).toBe('Version history');
    expect(count()).toBe(0);

    ribbons[0].callback(undefined as unknown as MouseEvent);
    expect(count()).toBe(1);
  });

  it('registers the same action as a toolbar-pinnable command', () => {
    const { host, commands, count } = makeFakeHost();
    registerVersionHistoryEntryPoints(host);

    expect(commands).toHaveLength(1);
    expect(commands[0].id).toBe(CMD_VERSION_HISTORY.id);
    expect(commands[0].id).toBe('show-version-history');
    expect(commands[0].icon).toBe(VERSION_HISTORY_ICON);

    const callback = commands[0].callback;
    if (!callback) throw new Error('Version history command has no callback');
    callback();
    expect(count()).toBe(1);
  });
});

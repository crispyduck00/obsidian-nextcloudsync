import type { Command, IconName } from 'obsidian';

/** Lucide icon used consistently for every Version history entry point. */
export const VERSION_HISTORY_ICON: IconName = 'history';

/** Ribbon/menu label. */
export const VERSION_HISTORY_LABEL = 'Version history';

/**
 * Command identity. Obsidian uses Command.icon when the command is pinned to the mobile toolbar,
 * so the same history glyph appears there as in the desktop ribbon and file menu.
 */
export const CMD_VERSION_HISTORY = {
  id: 'show-version-history',
  name: 'Show version history',
  icon: VERSION_HISTORY_ICON,
} as const;

export interface VersionHistoryEntryPointHost {
  addRibbonIcon(icon: IconName, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement;
  addCommand(command: Command): unknown;
  openVersionHistoryForActiveFile(): unknown;
}

/**
 * One shared entry point for desktop ribbon, mobile Open menu, command palette, hotkey, and a
 * user-pinned mobile toolbar button. The host owns active-file/config validation so every route
 * produces the same notices and opens the same modal.
 */
export function registerVersionHistoryEntryPoints(host: VersionHistoryEntryPointHost): void {
  host.addRibbonIcon(VERSION_HISTORY_ICON, VERSION_HISTORY_LABEL, () => {
    void host.openVersionHistoryForActiveFile();
  });

  host.addCommand({
    ...CMD_VERSION_HISTORY,
    callback: () => {
      void host.openVersionHistoryForActiveFile();
    },
  });
}

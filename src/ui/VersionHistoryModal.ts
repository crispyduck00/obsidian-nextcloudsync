import { App, Modal, Notice } from 'obsidian';
import { FileVersion } from '../types';
import { confirmModal } from './ConfirmModal';

export class BusyGate {
  private busy = false;
  tryEnter(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }
  leave(): void { this.busy = false; }
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function authorLabel(version: FileVersion, currentUserId: string): string {
  if (!version.author) return 'Author unavailable';
  return version.author === currentUserId ? 'You' : version.author;
}

/**
 * Nextcloud-retained file history. Version bodies stay lazy: only a chosen comparison or Line
 * history downloads retained content.
 */
export class VersionHistoryModal extends Modal {
  private readonly restoreGate = new BusyGate();

  constructor(
    app: App,
    private readonly filePath: string,
    private readonly versions: FileVersion[],
    private readonly currentUserId: string,
    private readonly onCompare: (
      before: FileVersion, after: FileVersion, restoreTarget: FileVersion | null,
    ) => void,
    private readonly onLineHistory: (version: FileVersion) => void,
    private readonly onRestore: (version: FileVersion) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass('ncs-version-history-modal');
    contentEl.empty();
    this.setTitle('Version history');
    contentEl.createEl('p', { text: this.filePath, cls: 'setting-item-description' });

    if (this.versions.length === 0) {
      contentEl.createEl('p', { text: 'No server version history for this file.' });
      return;
    }

    const intro = contentEl.createDiv({ cls: 'ncs-version-history-intro' });
    intro.createDiv({
      text: 'History is based on the versions currently retained by Nextcloud.',
      cls: 'setting-item-description',
    });

    const byTime = [...this.versions].sort((a, b) => b.lastModified - a.lastModified);
    const current = byTime.find((v) => v.isCurrent);
    // Current is a STATE, not necessarily the newest timestamp: a restored historical revision can
    // be Current while newer pre-restore revisions remain in history. Pin Current visually without
    // changing chronological calculations used for "previous" and line provenance.
    const ordered = current
      ? [current, ...byTime.filter((version) => version !== current)]
      : byTime;
    const oldest = Math.min(...byTime.map((v) => v.lastModified));
    const list = contentEl.createDiv({ cls: 'ncs-version-list' });

    for (let index = 0; index < ordered.length; index++) {
      const version = ordered[index];
      const previous = byTime.find((candidate) =>
        !candidate.isCurrent && candidate.lastModified < version.lastModified,
      );

      const card = list.createDiv({ cls: 'ncs-version-card' });
      const title = card.createDiv({ cls: 'ncs-version-title' });
      if (version.label) {
        title.createSpan({ text: version.label });
        if (version.isCurrent) title.createSpan({ text: ' · Current', cls: 'ncs-version-current' });
      } else if (version.isCurrent) {
        title.setText('Current version');
      } else if (version.lastModified === oldest) {
        title.setText('Oldest available version');
      } else {
        title.setText('Available version');
      }

      const date = new Date(version.lastModified).toLocaleString();
      card.createDiv({
        text: `${authorLabel(version, this.currentUserId)} · ${date} · ${sizeLabel(version.size)}`,
        cls: 'ncs-version-meta',
      });

      if (version.versionId) {
        card.createDiv({ text: `Version ID: ${version.versionId}`, cls: 'ncs-version-id' });
      }

      const actions = card.createDiv({ cls: 'ncs-version-actions' });

      if (!version.isCurrent && current) {
        const compareCurrent = actions.createEl('button', { text: 'Compare current' });
        compareCurrent.addEventListener('click', () => this.onCompare(version, current, version));
      }

      if (previous) {
        const comparePrevious = actions.createEl('button', { text: 'Compare previous' });
        comparePrevious.addEventListener(
          'click',
          () => this.onCompare(previous, version, version.isCurrent ? null : version),
        );
      }

      const lineHistory = actions.createEl('button', { text: 'Line history' });
      lineHistory.addEventListener('click', () => this.onLineHistory(version));

      if (!version.isCurrent) {
        const restore = actions.createEl('button', { text: 'Restore', cls: 'mod-warning' });
        restore.addEventListener('click', () => void this.restore(version, date));
      }
    }
  }

  private async restore(version: FileVersion, date: string): Promise<void> {
    if (!this.restoreGate.tryEnter()) return;
    try {
      const confirmed = await confirmModal(this.app, {
        title: 'Restore version',
        message:
          `Restore "${this.filePath}" to the version from ${date}? ` +
          'Unsaved local changes to this file will be overwritten.',
        cta: 'Restore',
        destructive: true,
      });
      if (!confirmed) return;
      await this.onRestore(version);
      new Notice(`✅ Restored ${this.filePath} (${date})`, 5000);
      this.close();
    } catch (err) {
      new Notice(`❌ Restore failed: ${(err as Error).message}`, 6000);
    } finally {
      this.restoreGate.leave();
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

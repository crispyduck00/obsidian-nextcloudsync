import { App, Modal, Notice } from 'obsidian';
import { FileVersion } from '../types';
import { LineHistoryLine, LineHistoryResult } from '../sync/versions/lineHistory';
import { confirmModal } from './ConfirmModal';

function authorLabel(version: FileVersion, currentUserId: string): string {
  if (!version.author) return 'Unavailable';
  return version.author === currentUserId ? 'You' : version.author;
}

function provenanceKey(version: FileVersion): string {
  return `${version.versionId}\u0000${version.lastModified}\u0000${version.author ?? ''}`;
}

function shortDate(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function authorBucket(author: string | null | undefined): number {
  const value = author ?? 'unknown';
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return Math.abs(hash) % 8;
}

export class LineHistoryModal extends Modal {
  constructor(
    app: App,
    private readonly filePath: string,
    private readonly currentUserId: string,
    private readonly targetVersion: FileVersion,
    private readonly loadHistory: () => Promise<LineHistoryResult>,
    private readonly onRestore?: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('ncs-line-history-modal');
    this.setTitle('Line history');
    this.renderLoading();
    void this.load();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async restoreSelected(): Promise<void> {
    if (this.targetVersion.isCurrent || !this.onRestore) return;
    const date = new Date(this.targetVersion.lastModified).toLocaleString();
    const confirmed = await confirmModal(this.app, {
      title: 'Restore version',
      message:
        `Restore "${this.filePath}" to this version from ${date}? ` +
        'Unsaved local changes to this file will be overwritten.',
      cta: 'Restore',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      await this.onRestore();
      new Notice(`✅ Restored ${this.filePath} (${date})`, 5000);
      this.close();
    } catch (err) {
      new Notice(`❌ Restore failed: ${(err as Error).message}`, 6000);
    }
  }

  private renderLoading(): void {
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: this.filePath, cls: 'setting-item-description' });
    this.contentEl.createEl('p', {
      text: 'Loading available Nextcloud versions…',
      cls: 'setting-item-description',
    });
  }

  private async load(): Promise<void> {
    try {
      this.render(await this.loadHistory());
    } catch (err) {
      new Notice(`❌ Line history failed: ${(err as Error).message}`, 6000);
      this.close();
    }
  }

  private render(result: LineHistoryResult): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', { text: this.filePath, cls: 'setting-item-description' });

    const controls = contentEl.createDiv({ cls: 'ncs-version-view-controls' });
    const wrapButton = controls.createEl('button', { text: 'Wrap lines: on' });
    if (!this.targetVersion.isCurrent && this.onRestore) {
      const restoreButton = controls.createEl('button', {
        text: 'Restore this version',
        cls: 'mod-warning',
      });
      restoreButton.addEventListener('click', () => void this.restoreSelected());
    }

    const note = contentEl.createDiv({ cls: 'ncs-line-history-note' });
    note.createEl('strong', { text: 'Based on available Nextcloud history. ' });
    note.createSpan({
      text:
        'The author and date identify the earliest available history state in which each target line can be traced. ' +
        'After a restore, Current content can also anchor its preserved historical revision time. ' +
        'This is not proof of the original line author; pruned intermediate versions cannot be reconstructed.',
    });
    note.createDiv({
      text: `${result.versionCount} history state${result.versionCount === 1 ? '' : 's'} used.`,
      cls: 'ncs-line-history-count',
    });
    if (result.approximate) {
      note.createDiv({
        text: 'Large-file fallback used for at least one comparison; attribution is approximate.',
        cls: 'ncs-line-history-warning',
      });
    }

    if (result.lines.length === 0) {
      contentEl.createEl('p', { text: '(Empty file)' });
      return;
    }

    const list = contentEl.createDiv({ cls: 'ncs-blame-list' });
    let wrapped = true;
    const applyWrap = () => {
      list.toggleClass('is-nowrap', !wrapped);
      wrapButton.setText(`Wrap lines: ${wrapped ? 'on' : 'off'}`);
    };
    wrapButton.addEventListener('click', () => {
      wrapped = !wrapped;
      applyWrap();
    });
    applyWrap();

    let previousKey = '';
    for (const line of result.lines) {
      const key = provenanceKey(line.version);
      this.renderLine(list, line, key !== previousKey, result.oldestVersionTime);
      previousKey = key;
    }
  }

  private renderLine(
    list: HTMLElement,
    line: LineHistoryLine,
    firstInBlock: boolean,
    oldestVersionTime: number | null,
  ): void {
    const row = list.createDiv({ cls: 'ncs-blame-row' });
    row.addClass(`ncs-author-${authorBucket(line.version.author)}`);
    const provenance = row.createDiv({ cls: 'ncs-blame-provenance' });

    if (firstInBlock) {
      const isOldest = oldestVersionTime != null && line.version.lastModified === oldestVersionTime;
      const author = authorLabel(line.version, this.currentUserId);
      provenance.createDiv({ text: author, cls: 'ncs-blame-author' });
      provenance.createDiv({
        text: `${isOldest && !line.version.isCurrent ? '≤ ' : ''}${shortDate(line.version.lastModified)}`,
        cls: 'ncs-blame-date',
      });
      if (line.version.isCurrent) {
        provenance.createDiv({ text: 'Current', cls: 'ncs-blame-current' });
      } else if (line.version.isCurrentRevisionAnchor) {
        provenance.createDiv({ text: 'Restored source', cls: 'ncs-blame-current' });
      }
    }

    row.createDiv({ text: String(line.lineNumber), cls: 'ncs-blame-line-number' });
    row.createDiv({ text: line.text || ' ', cls: 'ncs-blame-text' });
  }
}

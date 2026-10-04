import { App, Modal, Notice } from 'obsidian';
import { FileVersion } from '../types';
import { LineHistoryLine, LineHistoryResult } from '../sync/versions/lineHistory';

function authorLabel(version: FileVersion, currentUserId: string): string {
  if (!version.author) return 'Unknown';
  return version.author === currentUserId ? 'You' : version.author;
}

function provenanceKey(version: FileVersion): string {
  return `${version.versionId}\u0000${version.lastModified}\u0000${version.author ?? ''}`;
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' });
}

export class LineHistoryModal extends Modal {
  constructor(
    app: App,
    private readonly filePath: string,
    private readonly currentUserId: string,
    private readonly loadHistory: () => Promise<LineHistoryResult>,
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

    const note = contentEl.createDiv({ cls: 'ncs-line-history-note' });
    note.createEl('strong', { text: 'Based on available Nextcloud versions. ' });
    note.createSpan({
      text:
        'The author and date identify the retained version in which each current line can first be traced. ' +
        'This is not proof of the original line author; pruned intermediate versions cannot be reconstructed.',
    });
    note.createDiv({
      text: `${result.versionCount} available version${result.versionCount === 1 ? '' : 's'} used.`,
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
    const provenance = row.createDiv({ cls: 'ncs-blame-provenance' });

    if (firstInBlock) {
      const isOldest = oldestVersionTime != null && line.version.lastModified === oldestVersionTime;
      const author = authorLabel(line.version, this.currentUserId);
      provenance.createDiv({
        text: line.version.isCurrent ? `${author} · Current` : author,
        cls: 'ncs-blame-author',
      });
      provenance.createDiv({
        text: `${isOldest && !line.version.isCurrent ? '≤ ' : ''}${shortDate(line.version.lastModified)}`,
        cls: 'ncs-blame-date',
      });
    }

    row.createDiv({ text: String(line.lineNumber), cls: 'ncs-blame-line-number' });
    row.createDiv({ text: line.text || ' ', cls: 'ncs-blame-text' });
  }
}

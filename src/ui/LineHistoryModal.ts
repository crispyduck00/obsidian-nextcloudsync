import { App, Modal, Notice } from 'obsidian';
import { FileVersion } from '../types';
import { LineHistoryLine, LineHistoryResult } from '../sync/versions/lineHistory';

function authorLabel(version: FileVersion, currentUserId: string): string {
  if (!version.author) return 'Unknown author';
  return version.author === currentUserId ? 'You' : version.author;
}

function provenanceKey(version: FileVersion): string {
  return `${version.versionId}\u0000${version.lastModified}\u0000${version.author ?? ''}`;
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
      const result = await this.loadHistory();
      this.render(result);
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
        'The author shown is the author recorded for the retained version in which a current line can first be traced. ' +
        'It does not prove who originally wrote that line, and pruned intermediate versions cannot be reconstructed.',
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

    const oldestTime = result.oldestVersionTime;

    const list = contentEl.createDiv({ cls: 'ncs-line-history-list' });
    let group: HTMLElement | null = null;
    let previousKey = '';
    for (const line of result.lines) {
      const key = provenanceKey(line.version);
      if (key !== previousKey) {
        group = list.createDiv({ cls: 'ncs-line-history-group' });
        this.renderGroupHeader(group, line.version, oldestTime);
        previousKey = key;
      }
      this.renderLine(group!, line);
    }
  }

  private renderGroupHeader(group: HTMLElement, version: FileVersion, oldestTime: number | null): void {
    const header = group.createDiv({ cls: 'ncs-line-history-group-header' });
    const date = new Date(version.lastModified).toLocaleString();
    const prefix = version.isCurrent
      ? 'Current version'
      : oldestTime != null && version.lastModified === oldestTime
        ? '≤ Oldest available version'
        : 'Available version';
    const label = version.label ? ` · ${version.label}` : '';
    header.createDiv({ text: `${prefix}${label}`, cls: 'ncs-line-history-version' });
    header.createDiv({
      text: `${authorLabel(version, this.currentUserId)} · ${date}`,
      cls: 'ncs-line-history-meta',
    });
  }

  private renderLine(group: HTMLElement, line: LineHistoryLine): void {
    const row = group.createDiv({ cls: 'ncs-line-history-row' });
    row.createDiv({ text: String(line.lineNumber), cls: 'ncs-line-history-gutter' });
    row.createDiv({ text: line.text || ' ', cls: 'ncs-line-history-text' });
  }
}

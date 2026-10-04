import { App, Modal, Notice } from 'obsidian';
import { FileVersion } from '../types';
import { VersionComparison } from '../sync/versions/VersionService';
import { renderDiffSections } from './diffRender';

function authorLabel(version: FileVersion, currentUserId: string): string {
  if (!version.author) return 'Unknown author';
  return version.author === currentUserId ? 'You' : version.author;
}

export class VersionCompareModal extends Modal {
  constructor(
    app: App,
    private readonly filePath: string,
    private readonly version: FileVersion,
    private readonly currentUserId: string,
    private readonly loadComparison: () => Promise<VersionComparison>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('ncs-diff-modal');
    this.setTitle('Compare version');
    this.renderLoading();
    void this.load();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderLoading(): void {
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: this.filePath, cls: 'setting-item-description' });
    this.contentEl.createEl('p', { text: 'Loading version and current file…', cls: 'setting-item-description' });
  }

  private async load(): Promise<void> {
    try {
      const result = await this.loadComparison();
      const date = new Date(this.version.lastModified).toLocaleString();
      this.contentEl.empty();
      this.contentEl.createEl('p', { text: this.filePath, cls: 'setting-item-description' });
      this.contentEl.createEl('p', {
        text: `${authorLabel(this.version, this.currentUserId)} · ${date} → Current remote version`,
        cls: 'setting-item-description',
      });

      const headers = this.contentEl.createDiv({ cls: 'ncs-diff-headers' });
      for (const label of ['Selected version', 'Current']) {
        headers.createDiv({ cls: 'ncs-diff-gutter' });
        headers.createDiv({ cls: 'ncs-diff-marker' });
        headers.createDiv({ text: label, cls: 'ncs-diff-header-cell' });
      }

      const scrollEl = this.contentEl.createDiv({ cls: 'ncs-diff-scroll' });
      const firstChanged = renderDiffSections(scrollEl, result.versionText, result.currentText);
      if (firstChanged) {
        window.requestAnimationFrame(() => firstChanged.scrollIntoView({ block: 'center' }));
      }
    } catch (err) {
      new Notice(`❌ Version compare failed: ${(err as Error).message}`, 6000);
      this.close();
    }
  }
}

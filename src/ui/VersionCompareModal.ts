import { App, Modal, Notice } from 'obsidian';
import { FileVersion } from '../types';
import { VersionComparison } from '../sync/versions/VersionService';
import { renderDiffSections } from './diffRender';

function authorLabel(version: FileVersion, currentUserId: string): string {
  if (!version.author) return 'Unknown author';
  return version.author === currentUserId ? 'You' : version.author;
}

function versionLabel(version: FileVersion): string {
  if (version.isCurrent) return 'Current';
  return version.label || new Date(version.lastModified).toLocaleString();
}

export class VersionCompareModal extends Modal {
  constructor(
    app: App,
    private readonly filePath: string,
    private readonly before: FileVersion,
    private readonly after: FileVersion,
    private readonly currentUserId: string,
    private readonly loadComparison: () => Promise<VersionComparison>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('ncs-diff-modal');
    this.setTitle('Compare versions');
    this.renderLoading();
    void this.load();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderLoading(): void {
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: this.filePath, cls: 'setting-item-description' });
    this.contentEl.createEl('p', { text: 'Loading versions…', cls: 'setting-item-description' });
  }

  private async load(): Promise<void> {
    try {
      const result = await this.loadComparison();
      this.contentEl.empty();
      this.contentEl.createEl('p', { text: this.filePath, cls: 'setting-item-description' });
      this.contentEl.createEl('p', {
        text:
          `${authorLabel(result.before, this.currentUserId)} · ${new Date(result.before.lastModified).toLocaleString()} ` +
          `→ ${authorLabel(result.after, this.currentUserId)} · ${new Date(result.after.lastModified).toLocaleString()}`,
        cls: 'setting-item-description',
      });

      const headers = this.contentEl.createDiv({ cls: 'ncs-diff-headers' });
      for (const label of [versionLabel(result.before), versionLabel(result.after)]) {
        headers.createDiv({ cls: 'ncs-diff-gutter' });
        headers.createDiv({ cls: 'ncs-diff-marker' });
        headers.createDiv({ text: label, cls: 'ncs-diff-header-cell' });
      }

      const scrollEl = this.contentEl.createDiv({ cls: 'ncs-diff-scroll' });
      const firstChanged = renderDiffSections(scrollEl, result.beforeText, result.afterText);
      if (firstChanged) {
        window.requestAnimationFrame(() => firstChanged.scrollIntoView({ block: 'center' }));
      }
    } catch (err) {
      new Notice(`❌ Version compare failed: ${(err as Error).message}`, 6000);
      this.close();
    }
  }
}

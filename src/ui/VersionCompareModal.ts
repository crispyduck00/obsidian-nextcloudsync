import { App, Modal, Notice } from 'obsidian';
import { FileVersion } from '../types';
import { VersionComparison } from '../sync/versions/VersionService';
import { renderDiffSections } from './diffRender';
import { renderVersionUnifiedDiff } from './versionUnifiedDiff';

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

      const controls = this.contentEl.createDiv({ cls: 'ncs-version-view-controls' });
      const wrapButton = controls.createEl('button', { text: 'Wrap lines: on' });

      const headers = this.contentEl.createDiv({ cls: 'ncs-diff-headers' });
      for (const label of [versionLabel(result.before), versionLabel(result.after)]) {
        headers.createDiv({ cls: 'ncs-diff-gutter' });
        headers.createDiv({ cls: 'ncs-diff-marker' });
        headers.createDiv({ text: label, cls: 'ncs-diff-header-cell' });
      }

      const desktopScroll = this.contentEl.createDiv({ cls: 'ncs-diff-scroll ncs-version-diff-desktop' });
      const desktopFirstChanged = renderDiffSections(desktopScroll, result.beforeText, result.afterText);

      const mobileScroll = this.contentEl.createDiv({ cls: 'ncs-version-unified ncs-version-diff-mobile' });
      const mobileFirstChanged = renderVersionUnifiedDiff(mobileScroll, result.beforeText, result.afterText);

      let wrapped = true;
      const applyWrap = () => {
        for (const el of [desktopScroll, mobileScroll]) el.toggleClass('is-nowrap', !wrapped);
        wrapButton.setText(`Wrap lines: ${wrapped ? 'on' : 'off'}`);
      };
      wrapButton.addEventListener('click', () => {
        wrapped = !wrapped;
        applyWrap();
      });
      applyWrap();

      const firstChanged = window.matchMedia('(max-width: 600px)').matches
        ? mobileFirstChanged
        : desktopFirstChanged;
      if (firstChanged) {
        window.requestAnimationFrame(() => firstChanged.scrollIntoView({ block: 'center' }));
      }
    } catch (err) {
      new Notice(`❌ Version compare failed: ${(err as Error).message}`, 6000);
      this.close();
    }
  }
}

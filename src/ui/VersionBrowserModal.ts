import { App, Component, MarkdownRenderer, Modal, Notice } from 'obsidian';
import { FileVersion } from '../types';
import { chronologicalVersionTimeline } from '../sync/versions/versionTimeline';
import { confirmModal } from './ConfirmModal';

function authorLabel(version: FileVersion, currentUserId: string): string {
  if (!version.author) return 'Author unavailable';
  return version.author === currentUserId ? 'You' : version.author;
}

function optionLabel(version: FileVersion, currentUserId: string): string {
  if (version.isCurrent) return 'Current';
  const date = new Date(version.lastModified).toLocaleString();
  if (version.isCurrentRevisionAnchor) return `${date} · Restored source · Current content`;
  return `${date} · ${authorLabel(version, currentUserId)}`;
}

export class VersionBrowserModal extends Modal {
  private readonly timeline: FileVersion[];
  private readonly restoredAnchor: FileVersion | undefined;
  private readonly cache = new Map<string, string>();
  private renderComponent = new Component();
  private selectedIndex: number;
  private renderedMode: boolean;
  private requestId = 0;

  constructor(
    app: App,
    private readonly filePath: string,
    versions: FileVersion[],
    private readonly currentUserId: string,
    private readonly loadText: (version: FileVersion) => Promise<string>,
    private readonly onRestore: (version: FileVersion) => Promise<void>,
  ) {
    super(app);
    this.timeline = chronologicalVersionTimeline(versions);
    this.restoredAnchor = versions.find((version) => version.isCurrentRevisionAnchor);
    this.selectedIndex = Math.max(0, this.timeline.length - 1);
    this.renderedMode = filePath.toLowerCase().endsWith('.md');
  }

  onOpen(): void {
    this.renderComponent.load();
    this.modalEl.addClass('ncs-version-browser-modal');
    this.setTitle('Version browser');

    const shouldKeepNativeArrowBehavior = (event: KeyboardEvent): boolean => {
      const target = event.target;
      return target instanceof HTMLInputElement
        || target instanceof HTMLSelectElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable);
    };
    this.scope.register([], 'ArrowLeft', (event) => {
      if (shouldKeepNativeArrowBehavior(event)) return;
      event.preventDefault();
      void this.select(this.selectedIndex - 1);
      return false;
    });
    this.scope.register([], 'ArrowRight', (event) => {
      if (shouldKeepNativeArrowBehavior(event)) return;
      event.preventDefault();
      void this.select(this.selectedIndex + 1);
      return false;
    });

    void this.render();
  }

  onClose(): void {
    this.requestId++;
    this.renderComponent.unload();
    this.contentEl.empty();
  }

  private versionKey(version: FileVersion): string {
    return `${version.versionId}\u0000${version.isCurrent ? 'current' : 'history'}`;
  }

  private async getText(version: FileVersion): Promise<string> {
    const key = this.versionKey(version);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const text = await this.loadText(version);
    this.cache.set(key, text);
    return text;
  }

  private async select(index: number): Promise<void> {
    const bounded = Math.max(0, Math.min(this.timeline.length - 1, index));
    if (bounded === this.selectedIndex) return;
    this.selectedIndex = bounded;
    await this.render();
  }

  private async restoreSelected(): Promise<void> {
    const version = this.timeline[this.selectedIndex];
    if (!version || version.isCurrent) return;
    const date = new Date(version.lastModified).toLocaleString();
    const confirmed = await confirmModal(this.app, {
      title: 'Restore version',
      message:
        `Restore "${this.filePath}" to the version from ${date}? ` +
        'Unsaved local changes to this file will be overwritten.',
      cta: 'Restore',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      await this.onRestore(version);
      new Notice(`✅ Restored ${this.filePath} (${date})`, 5000);
      this.close();
    } catch (err) {
      new Notice(`❌ Restore failed: ${(err as Error).message}`, 6000);
    }
  }

  private async render(): Promise<void> {
    const requestId = ++this.requestId;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', { text: this.filePath, cls: 'setting-item-description' });

    if (this.timeline.length === 0) {
      contentEl.createEl('p', { text: 'No server version history for this file.' });
      return;
    }

    const version = this.timeline[this.selectedIndex];

    const nav = contentEl.createDiv({ cls: 'ncs-version-browser-nav' });
    const previous = nav.createEl('button', { text: '←', attr: { 'aria-label': 'Previous version' } });
    previous.disabled = this.selectedIndex === 0;
    previous.addEventListener('click', () => void this.select(this.selectedIndex - 1));

    const slider = nav.createEl('input', {
      cls: 'ncs-version-browser-slider',
      attr: {
        type: 'range',
        min: '0',
        max: String(Math.max(0, this.timeline.length - 1)),
        step: '1',
        value: String(this.selectedIndex),
        'aria-label': 'Version timeline',
      },
    });
    slider.addEventListener('change', () => void this.select(Number(slider.value)));

    const next = nav.createEl('button', { text: '→', attr: { 'aria-label': 'Next version' } });
    next.disabled = this.selectedIndex === this.timeline.length - 1;
    next.addEventListener('click', () => void this.select(this.selectedIndex + 1));

    const selector = contentEl.createEl('select', { cls: 'ncs-version-browser-select' });
    this.timeline.forEach((item, index) => {
      const option = selector.createEl('option', {
        text: optionLabel(item, this.currentUserId),
        attr: { value: String(index) },
      });
      option.selected = index === this.selectedIndex;
    });
    selector.addEventListener('change', () => void this.select(Number(selector.value)));

    const meta = contentEl.createDiv({ cls: 'ncs-version-browser-meta' });
    meta.createDiv({
      text: version.isCurrent
        ? 'Current'
        : version.isCurrentRevisionAnchor
          ? `${new Date(version.lastModified).toLocaleString()} · Restored source revision`
          : new Date(version.lastModified).toLocaleString(),
      cls: 'ncs-version-browser-version',
    });
    meta.createDiv({
      text: version.isCurrent && this.restoredAnchor
        ? `Current state · content revision ${new Date(this.restoredAnchor.lastModified).toLocaleString()} · ${version.size} B`
        : version.isCurrentRevisionAnchor
          ? `Current content at its historical revision position · ${version.size} B`
          : `${authorLabel(version, this.currentUserId)} · ${version.size} B`,
      cls: 'setting-item-description',
    });

    const controls = contentEl.createDiv({ cls: 'ncs-version-view-controls ncs-version-browser-controls' });
    if (this.filePath.toLowerCase().endsWith('.md')) {
      const rendered = controls.createEl('button', { text: 'Rendered' });
      const source = controls.createEl('button', { text: 'Source' });
      rendered.toggleClass('mod-cta', this.renderedMode);
      source.toggleClass('mod-cta', !this.renderedMode);
      rendered.addEventListener('click', () => {
        if (!this.renderedMode) {
          this.renderedMode = true;
          void this.render();
        }
      });
      source.addEventListener('click', () => {
        if (this.renderedMode) {
          this.renderedMode = false;
          void this.render();
        }
      });
    }
    if (!version.isCurrent && !version.isCurrentRevisionAnchor) {
      const restore = controls.createEl('button', { text: 'Restore this version', cls: 'mod-warning' });
      restore.addEventListener('click', () => void this.restoreSelected());
    }

    const body = contentEl.createDiv({ cls: 'ncs-version-browser-body' });
    body.createDiv({ text: 'Loading version…', cls: 'setting-item-description' });

    try {
      const text = await this.getText(version);
      if (requestId !== this.requestId) return;
      body.empty();
      if (this.renderedMode && this.filePath.toLowerCase().endsWith('.md')) {
        this.renderComponent.unload();
        this.renderComponent = new Component();
        this.renderComponent.load();
        body.addClass('markdown-preview-view');
        await MarkdownRenderer.render(this.app, text, body, this.filePath, this.renderComponent);
      } else {
        body.createEl('pre', { text, cls: 'ncs-version-browser-source' });
      }
    } catch (err) {
      if (requestId !== this.requestId) return;
      body.empty();
      body.createEl('p', {
        text: `Could not load this version: ${(err as Error).message}`,
        cls: 'mod-warning',
      });
    }
  }
}

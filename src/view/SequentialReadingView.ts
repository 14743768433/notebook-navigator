/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { Component, ItemView, MarkdownRenderer, TFile, TFolder, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { NOTEBOOK_NAVIGATOR_ICON_ID } from '../constants/notebookNavigatorIcon';
import { strings } from '../i18n';
import type NotebookNavigatorPlugin from '../main';
import { NOTEBOOK_NAVIGATOR_SEQUENTIAL_READING_VIEW } from '../types';
import { getFileDisplayName } from '../utils/fileNameUtils';
import { runAsyncAction } from '../utils/async';
import { computeSequentialReadingOrder, splitMarkdownFrontmatter } from '../utils/sequentialReading';
import { showNotice } from '../utils/noticeUtils';
import { EmbeddableMarkdownEditor } from './EmbeddableMarkdownEditor';

export interface SequentialReadingViewState {
    folderPath?: string;
    focusPath?: string;
}

interface SectionRuntime {
    editor: EmbeddableMarkdownEditor | null;
    saveTimer: number | null;
    statusEl: HTMLElement;
    pendingSave: Promise<boolean> | null;
    lastSavedMarkdown: string;
}

const SAVE_DEBOUNCE_MS = 500;
const LOCAL_SAVE_REFRESH_GRACE_MS = 700;

let sequentialReadingViewInstanceCounter = 0;

function parseState(state: unknown): SequentialReadingViewState {
    if (!state || typeof state !== 'object') {
        return {};
    }

    const record = state as Record<string, unknown>;
    return {
        folderPath: typeof record.folderPath === 'string' ? record.folderPath : undefined,
        focusPath: typeof record.focusPath === 'string' ? record.focusPath : undefined
    };
}

function getFolderDisplayName(folder: TFolder, appName: string): string {
    return folder.path === '/' ? appName : folder.name;
}

export class SequentialReadingView extends ItemView {
    private readonly plugin: NotebookNavigatorPlugin;
    private readonly settingsUpdateListenerId: string;
    private container: HTMLElement | null = null;
    private renderComponent: Component | null = null;
    private folderPath = '';
    private focusPath: string | null = null;
    private currentFilePaths = new Set<string>();
    private refreshTimer: number | null = null;
    private renderRequestId = 0;
    private sectionRuntimeByPath = new Map<string, SectionRuntime>();
    private localSavePathCounts = new Map<string, number>();
    private editorFallbackNoticeShown = false;
    private hasDeferredRefresh = false;

    constructor(leaf: WorkspaceLeaf, plugin: NotebookNavigatorPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.navigation = true;
        sequentialReadingViewInstanceCounter += 1;
        this.settingsUpdateListenerId = `notebook-navigator-sequential-reading-${sequentialReadingViewInstanceCounter}`;
    }

    getViewType(): string {
        return NOTEBOOK_NAVIGATOR_SEQUENTIAL_READING_VIEW;
    }

    getDisplayText(): string {
        const folder = this.resolveFolder();
        if (!folder) {
            return strings.sequentialReading?.viewName ?? 'Sequential reading';
        }

        const prefix = strings.sequentialReading?.viewName ?? 'Sequential reading';
        return `${prefix}: ${getFolderDisplayName(folder, this.app.vault.getName())}`;
    }

    getIcon(): string {
        return NOTEBOOK_NAVIGATOR_ICON_ID;
    }

    getState(): Record<string, unknown> {
        return {
            folderPath: this.folderPath,
            focusPath: this.focusPath ?? undefined
        };
    }

    async setState(state: unknown, result: ViewStateResult): Promise<void> {
        await super.setState(state, result);
        const parsed = parseState(state);
        await this.setSequentialReadingState(parsed);
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1];
        if (!container.instanceOf(HTMLElement)) {
            return;
        }

        container.empty();
        container.classList.add('nn-sequential-reading-view');
        this.container = container;
        this.plugin.registerSettingsUpdateListener(this.settingsUpdateListenerId, () => this.scheduleRefresh('settings'));

        this.registerEvent(this.app.vault.on('create', () => this.scheduleRefresh('vault-create')));
        this.registerEvent(
            this.app.vault.on('modify', file => {
                if (file instanceof TFile && this.isLocalSavePath(file.path)) {
                    return;
                }
                this.scheduleRefresh('vault-modify');
            })
        );
        this.registerEvent(this.app.vault.on('delete', () => this.scheduleRefresh('vault-delete')));
        this.registerEvent(this.app.vault.on('rename', () => this.scheduleRefresh('vault-rename')));
        this.registerEvent(
            this.app.metadataCache.on('changed', file => {
                if (file instanceof TFile && this.isLocalSavePath(file.path)) {
                    return;
                }
                this.scheduleRefresh('metadata-changed');
            })
        );

        const unsubscribeHierarchy = this.plugin.hierarchyService?.subscribe(() => this.scheduleRefresh('hierarchy'));
        if (unsubscribeHierarchy) {
            this.register(unsubscribeHierarchy);
        }

        await this.render();
        this.plugin.notifySequentialReadingStateChanged();
    }

    async onClose(): Promise<void> {
        this.plugin.unregisterSettingsUpdateListener(this.settingsUpdateListenerId);
        if (this.refreshTimer !== null) {
            window.clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        await this.flushSectionRuntimes();
        this.clearSectionRuntimes();
        if (this.renderComponent) {
            this.removeChild(this.renderComponent);
        }
        this.renderComponent = null;
        this.container?.classList.remove('nn-sequential-reading-view');
        this.container?.empty();
        this.container = null;
        this.plugin.notifySequentialReadingStateChanged();
    }

    async setSequentialReadingState(state: SequentialReadingViewState): Promise<void> {
        const nextFolderPath = state.folderPath ?? this.folderPath;
        const folderChanged = nextFolderPath !== this.folderPath;
        this.folderPath = nextFolderPath;
        this.focusPath = state.focusPath ?? null;
        if (folderChanged) {
            this.plugin.notifySequentialReadingStateChanged();
        }

        if (this.container) {
            if (folderChanged) {
                await this.render();
                return;
            }
            if (this.focusPath) {
                this.revealFile(this.focusPath);
                return;
            }
        }
    }

    getSequentialReadingFolderPath(): string {
        return this.folderPath;
    }

    containsFile(filePath: string): boolean {
        if (this.currentFilePaths.has(filePath)) {
            return true;
        }

        try {
            return this.computeOrder().some(file => file.path === filePath);
        } catch {
            return false;
        }
    }

    revealFile(filePath: string): boolean {
        if (!this.containsFile(filePath)) {
            return false;
        }

        this.focusPath = filePath;
        const section = this.container?.querySelector<HTMLElement>(`[data-nn-sequential-path="${CSS.escape(filePath)}"]`);
        if (!section) {
            this.scheduleRefresh('reveal');
            return true;
        }

        section.scrollIntoView({ block: 'start', behavior: 'smooth' });
        section.classList.add('nn-sequential-reading-section-revealed');
        window.setTimeout(() => section.classList.remove('nn-sequential-reading-section-revealed'), 900);
        this.focusPath = null;
        return true;
    }

    private resolveFolder(): TFolder | null {
        if (!this.folderPath) {
            return null;
        }
        if (this.folderPath === '/') {
            return this.app.vault.getRoot();
        }
        return this.app.vault.getFolderByPath(this.folderPath);
    }

    private computeOrder(): TFile[] {
        const folder = this.resolveFolder();
        if (!folder) {
            return [];
        }

        return computeSequentialReadingOrder({
            app: this.app,
            folder,
            hierarchyParentByPath: this.plugin.hierarchyService?.getParentEntries() ?? null,
            settings: this.plugin.settings,
            visibility: this.plugin.getSequentialReadingVisibilityPreferences()
        });
    }

    private scheduleRefresh(reason: string): void {
        if (reason !== 'reveal' && this.hasFocusedEditor()) {
            this.hasDeferredRefresh = true;
            return;
        }

        if (this.refreshTimer !== null) {
            window.clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = window.setTimeout(() => {
            this.refreshTimer = null;
            runAsyncAction(() => this.render());
        }, 150);
    }

    private hasFocusedEditor(): boolean {
        for (const runtime of this.sectionRuntimeByPath.values()) {
            if (runtime.editor?.hasFocus()) {
                return true;
            }
        }
        return false;
    }

    private releaseDeferredRefreshIfIdle(): void {
        if (!this.hasDeferredRefresh || this.hasFocusedEditor()) {
            return;
        }

        this.hasDeferredRefresh = false;
        this.scheduleRefresh('deferred');
    }

    private isLocalSavePath(filePath: string): boolean {
        return (this.localSavePathCounts.get(filePath) ?? 0) > 0;
    }

    private beginLocalSave(filePath: string): void {
        this.localSavePathCounts.set(filePath, (this.localSavePathCounts.get(filePath) ?? 0) + 1);
    }

    private endLocalSaveSoon(filePath: string): void {
        window.setTimeout(() => {
            const currentCount = this.localSavePathCounts.get(filePath) ?? 0;
            if (currentCount <= 1) {
                this.localSavePathCounts.delete(filePath);
                return;
            }
            this.localSavePathCounts.set(filePath, currentCount - 1);
        }, LOCAL_SAVE_REFRESH_GRACE_MS);
    }

    private clearSaveStatus(runtime: SectionRuntime): void {
        runtime.statusEl.classList.remove(
            'nn-sequential-reading-status-error',
            'nn-sequential-reading-status-saving',
            'nn-sequential-reading-status-saved'
        );
        runtime.statusEl.setText('');
    }

    private async flushSectionRuntimes(): Promise<boolean> {
        const saveResults = await Promise.all(
            Array.from(this.sectionRuntimeByPath.entries()).map(async ([filePath, runtime]) => {
                if (runtime.editor) {
                    return this.saveSectionNow(filePath, runtime.editor.value, runtime);
                }
                if (runtime.pendingSave) {
                    return runtime.pendingSave;
                }
                return true;
            })
        );

        return saveResults.every(Boolean);
    }

    private clearSectionRuntimes(): void {
        for (const runtime of this.sectionRuntimeByPath.values()) {
            if (runtime.saveTimer !== null) {
                window.clearTimeout(runtime.saveTimer);
            }
            if (runtime.editor) {
                this.removeChild(runtime.editor);
            }
        }
        this.sectionRuntimeByPath.clear();
    }

    private async render(): Promise<void> {
        const container = this.container;
        if (!container) {
            return;
        }

        const requestId = ++this.renderRequestId;
        const previousScrollTop = container.scrollTop;
        const shouldRestoreScroll = !this.focusPath;
        const flushed = await this.flushSectionRuntimes();
        if (!flushed || requestId !== this.renderRequestId) {
            return;
        }

        const files = this.computeOrder();
        this.currentFilePaths = new Set(files.map(file => file.path));
        this.clearSectionRuntimes();
        if (this.renderComponent) {
            this.removeChild(this.renderComponent);
        }
        this.renderComponent = new Component();
        this.addChild(this.renderComponent);

        container.empty();

        const folder = this.resolveFolder();
        if (!folder) {
            this.renderMessage(container, strings.sequentialReading?.missingFolder ?? 'Folder not found.');
            return;
        }

        if (files.length === 0) {
            this.renderMessage(container, strings.sequentialReading?.emptyFolder ?? 'This folder has no Markdown notes.');
            return;
        }

        const content = container.createDiv({ cls: 'nn-sequential-reading-content' });
        for (const file of files) {
            if (requestId !== this.renderRequestId) {
                return;
            }
            await this.renderSection(content, file);
        }

        if (requestId !== this.renderRequestId) {
            return;
        }
        if (this.focusPath) {
            this.revealFile(this.focusPath);
        } else if (shouldRestoreScroll) {
            window.requestAnimationFrame(() => {
                if (this.container === container) {
                    container.scrollTop = Math.min(previousScrollTop, Math.max(0, container.scrollHeight - container.clientHeight));
                }
            });
        }
    }

    private renderMessage(container: HTMLElement, message: string): void {
        const empty = container.createDiv({ cls: 'nn-sequential-reading-empty' });
        empty.setText(message);
    }

    private async renderSection(parent: HTMLElement, file: TFile): Promise<void> {
        const section = parent.createDiv({ cls: 'nn-sequential-reading-section' });
        section.dataset.nnSequentialPath = file.path;

        const divider = section.createDiv({ cls: 'nn-sequential-reading-divider' });
        const label = divider.createSpan({ cls: 'nn-sequential-reading-divider-label' });
        label.setText(getFileDisplayName(file, undefined, this.plugin.settings));
        label.setAttribute('title', file.path);
        label.setAttribute('aria-label', file.path);

        const body = section.createDiv({ cls: 'nn-sequential-reading-body' });
        const status = section.createDiv({ cls: 'nn-sequential-reading-status' });

        try {
            const content = await this.app.vault.cachedRead(file);
            const markdownBody = splitMarkdownFrontmatter(content).body;
            const runtime: SectionRuntime = {
                editor: null,
                saveTimer: null,
                statusEl: status,
                pendingSave: null,
                lastSavedMarkdown: markdownBody
            };
            this.sectionRuntimeByPath.set(file.path, runtime);
            this.renderEditableBody(body, file, markdownBody, runtime);
        } catch (error) {
            await this.renderReadonlyFallback(body, file, strings.sequentialReading?.sectionReadFailed ?? 'Failed to read this note.');
            status.setText(error instanceof Error ? error.message : String(error));
            status.classList.add('nn-sequential-reading-status-error');
        }
    }

    private renderEditableBody(container: HTMLElement, file: TFile, markdownBody: string, runtime: SectionRuntime): void {
        try {
            const editor = this.addChild(
                new EmbeddableMarkdownEditor(this.app, container, {
                    value: markdownBody,
                    file,
                    cls: 'nn-sequential-reading-editor',
                    onChange: (_update, changedEditor) => this.scheduleSectionSave(file.path, changedEditor.value, runtime),
                    onBlur: changedEditor => {
                        runAsyncAction(async () => {
                            await this.saveSectionNow(file.path, changedEditor.value, runtime);
                            this.releaseDeferredRefreshIfIdle();
                        });
                    },
                    onEscape: changedEditor => {
                        runAsyncAction(async () => {
                            await this.saveSectionNow(file.path, changedEditor.value, runtime);
                            this.releaseDeferredRefreshIfIdle();
                        });
                    }
                })
            );
            runtime.editor = editor;
            if (markdownBody.length === 0) {
                container.classList.add('nn-sequential-reading-body-empty');
            }
        } catch (error) {
            if (!this.editorFallbackNoticeShown) {
                this.editorFallbackNoticeShown = true;
                showNotice(
                    strings.sequentialReading?.editorUnavailable ?? 'Sequential reading editor is unavailable; showing read-only preview.',
                    {
                        variant: 'warning'
                    }
                );
            }
            container.classList.add('nn-sequential-reading-readonly-fallback');
            runtime.statusEl.classList.add('nn-sequential-reading-status-error');
            runtime.statusEl.setText(error instanceof Error ? error.message : String(error));
            runAsyncAction(() => this.renderReadonlyFallback(container, file, markdownBody));
        }
    }

    private async renderReadonlyFallback(container: HTMLElement, file: TFile, markdownBody: string): Promise<void> {
        if (!markdownBody) {
            return;
        }
        await MarkdownRenderer.render(this.app, markdownBody, container, file.path, this.renderComponent ?? this);
    }

    private scheduleSectionSave(filePath: string, bodyMarkdown: string, runtime: SectionRuntime): void {
        this.clearSaveStatus(runtime);

        if (runtime.saveTimer !== null) {
            window.clearTimeout(runtime.saveTimer);
        }
        runtime.saveTimer = window.setTimeout(() => {
            runtime.saveTimer = null;
            runAsyncAction(() => this.saveSectionNow(filePath, bodyMarkdown, runtime));
        }, SAVE_DEBOUNCE_MS);
    }

    private async saveSectionNow(filePath: string, bodyMarkdown: string, runtime: SectionRuntime): Promise<boolean> {
        if (runtime.saveTimer !== null) {
            window.clearTimeout(runtime.saveTimer);
            runtime.saveTimer = null;
        }

        const previousSave = runtime.pendingSave;
        const saveTask = (async (): Promise<boolean> => {
            if (previousSave) {
                await previousSave;
            }
            if (bodyMarkdown === runtime.lastSavedMarkdown) {
                this.clearSaveStatus(runtime);
                this.releaseDeferredRefreshIfIdle();
                return true;
            }

            this.beginLocalSave(filePath);
            try {
                await this.plugin.saveSequentialReadingSection(filePath, bodyMarkdown);
                runtime.lastSavedMarkdown = bodyMarkdown;
                this.clearSaveStatus(runtime);
                this.releaseDeferredRefreshIfIdle();
                return true;
            } catch (error) {
                runtime.statusEl.classList.remove('nn-sequential-reading-status-saving', 'nn-sequential-reading-status-saved');
                runtime.statusEl.classList.add('nn-sequential-reading-status-error');
                runtime.statusEl.setText(strings.sequentialReading?.saveFailed ?? 'Save failed');
                showNotice(error instanceof Error ? error.message : String(error), { variant: 'warning' });
                return false;
            } finally {
                this.endLocalSaveSoon(filePath);
            }
        })();

        let trackedSaveTask: Promise<boolean> | null = null;
        trackedSaveTask = (async (): Promise<boolean> => {
            const result = await saveTask;
            if (trackedSaveTask && runtime.pendingSave === trackedSaveTask) {
                runtime.pendingSave = null;
            }
            return result;
        })();

        runtime.pendingSave = trackedSaveTask;
        return trackedSaveTask;
    }
}

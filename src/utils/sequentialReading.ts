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

import { TFile, TFolder, type App, type Vault } from 'obsidian';
import type { NotebookNavigatorSettings } from '../settings/types';
import type { VisibilityPreferences } from '../types';
import { ItemType } from '../types';
import { getFilesForNavigationSelection } from './selectionUtils';
import { getEffectiveListSort, isManualSortPropertyKey } from './sortUtils';
import { getCachedManualSortRank } from './manualSort';
import { partitionPinnedFiles } from './fileFinder';

export interface SequentialReadingOrderDeps {
    app: App;
    folder: TFolder;
    hierarchyParentByPath?: ReadonlyMap<string, string> | null;
    settings: NotebookNavigatorSettings;
    visibility: VisibilityPreferences;
}

export interface MarkdownFrontmatterParts {
    body: string;
    hasFrontmatter: boolean;
    prefix: string;
}

function isDirectChildOfFolder(file: TFile, folder: TFolder): boolean {
    return file.parent instanceof TFolder && file.parent.path === folder.path;
}

function buildHierarchyOrder({
    app,
    candidates,
    folder,
    hierarchyParentByPath,
    propertySortKey
}: {
    app: App;
    candidates: readonly TFile[];
    folder: TFolder;
    hierarchyParentByPath: ReadonlyMap<string, string>;
    propertySortKey: string;
}): TFile[] | null {
    const markdownFiles = candidates.filter(file => file.extension === 'md' && isDirectChildOfFolder(file, folder));
    const markdownPathSet = new Set(markdownFiles.map(file => file.path));
    if (markdownPathSet.size === 0) {
        return null;
    }

    let hasCurrentFolderHierarchy = false;
    for (const [childPath, parentPath] of hierarchyParentByPath) {
        if (markdownPathSet.has(childPath) && markdownPathSet.has(parentPath)) {
            hasCurrentFolderHierarchy = true;
            break;
        }
    }

    if (!hasCurrentFolderHierarchy) {
        return null;
    }

    const fileByPath = new Map(markdownFiles.map(file => [file.path, file]));
    const originalIndexByPath = new Map(candidates.map((file, index) => [file.path, index]));
    const childrenByParent = new Map<string, TFile[]>();
    const roots: TFile[] = [];

    markdownFiles.forEach(file => {
        const parentPath = hierarchyParentByPath.get(file.path) ?? null;
        if (parentPath && fileByPath.has(parentPath)) {
            const children = childrenByParent.get(parentPath) ?? [];
            children.push(file);
            childrenByParent.set(parentPath, children);
            return;
        }

        roots.push(file);
    });

    const sortSiblings = (left: TFile, right: TFile): number => {
        const leftRank = getCachedManualSortRank(app, left, propertySortKey);
        const rightRank = getCachedManualSortRank(app, right, propertySortKey);
        if (leftRank !== null && rightRank !== null && leftRank !== rightRank) {
            return leftRank - rightRank;
        }
        if (leftRank !== null) {
            return -1;
        }
        if (rightRank !== null) {
            return 1;
        }

        return (originalIndexByPath.get(left.path) ?? 0) - (originalIndexByPath.get(right.path) ?? 0);
    };

    roots.sort(sortSiblings);
    childrenByParent.forEach(children => children.sort(sortSiblings));

    const ordered: TFile[] = [];
    const visit = (file: TFile): void => {
        ordered.push(file);
        const children = childrenByParent.get(file.path) ?? [];
        children.forEach(visit);
    };

    roots.forEach(visit);
    return ordered;
}

export function computeSequentialReadingOrder({
    app,
    folder,
    hierarchyParentByPath = null,
    settings,
    visibility
}: SequentialReadingOrderDeps): TFile[] {
    const files = getFilesForNavigationSelection(
        {
            selectionType: ItemType.FOLDER,
            selectedFolder: folder,
            selectedTag: null,
            selectedProperty: null
        },
        settings,
        visibility,
        app,
        null,
        null
    );

    const pinnedDisplayScope = settings.filterPinnedByFolder ? { restrictToFolderPath: folder.path } : undefined;
    const { pinnedFiles, unpinnedFiles } = partitionPinnedFiles(files, settings.pinnedNotes, ItemType.FOLDER, pinnedDisplayScope);
    const markdownPinnedFiles = pinnedFiles.filter(file => file.extension === 'md');
    const markdownUnpinnedFiles = unpinnedFiles.filter(file => file.extension === 'md');
    const sortSpec = getEffectiveListSort(settings, ItemType.FOLDER, folder);
    const isManualSortActive = isManualSortPropertyKey({ manualSortPropertyKey: settings.manualSortPropertyKey }, sortSpec.propertyKey);

    if (!hierarchyParentByPath || !isManualSortActive) {
        return [...markdownPinnedFiles, ...markdownUnpinnedFiles];
    }

    const hierarchyOrder = buildHierarchyOrder({
        app,
        candidates: markdownUnpinnedFiles,
        folder,
        hierarchyParentByPath,
        propertySortKey: sortSpec.propertyKey
    });

    return [...markdownPinnedFiles, ...(hierarchyOrder ?? markdownUnpinnedFiles)];
}

export function splitMarkdownFrontmatter(content: string): MarkdownFrontmatterParts {
    const hasBom = content.startsWith('\uFEFF');
    const bom = hasBom ? '\uFEFF' : '';
    const markdown = hasBom ? content.slice(1) : content;
    const opening = markdown.match(/^---[ \t]*(?:\r?\n)/);

    if (!opening) {
        return { body: markdown, hasFrontmatter: false, prefix: bom };
    }

    let cursor = opening[0].length;
    while (cursor < markdown.length) {
        const nextNewline = markdown.indexOf('\n', cursor);
        const lineEnd = nextNewline === -1 ? markdown.length : nextNewline + 1;
        const line = markdown.slice(cursor, nextNewline === -1 ? lineEnd : nextNewline).replace(/\r$/, '');

        if (line.trim() === '---') {
            return {
                body: markdown.slice(lineEnd),
                hasFrontmatter: true,
                prefix: bom + markdown.slice(0, lineEnd)
            };
        }

        cursor = lineEnd;
    }

    return { body: markdown, hasFrontmatter: false, prefix: bom };
}

export function joinMarkdownFrontmatter(parts: Pick<MarkdownFrontmatterParts, 'prefix'>, body: string): string {
    return `${parts.prefix}${body}`;
}

export async function saveSequentialReadingSection(
    vault: Pick<Vault, 'modify' | 'read'>,
    file: TFile,
    bodyMarkdown: string
): Promise<void> {
    const original = await vault.read(file);
    const parts = splitMarkdownFrontmatter(original);
    await vault.modify(file, joinMarkdownFrontmatter(parts, bodyMarkdown));
}

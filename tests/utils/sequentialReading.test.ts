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

import { describe, expect, it, vi } from 'vitest';
import { App, TFile, TFolder, type Vault } from 'obsidian';
import { DEFAULT_SETTINGS } from '../../src/settings/defaultSettings';
import type { NotebookNavigatorSettings } from '../../src/settings/types';
import {
    computeSequentialReadingOrder,
    joinMarkdownFrontmatter,
    saveSequentialReadingSection,
    splitMarkdownFrontmatter
} from '../../src/utils/sequentialReading';
import { createTestTFile } from './createTestTFile';

function createFolder(path: string, parent: TFolder | null = null): TFolder {
    const folder = new TFolder(path) as TFolder & { children: Array<TFolder | TFile>; parent: TFolder | null };
    folder.children = [];
    folder.parent = parent;
    folder.path = path;
    folder.name = path === '/' ? '' : (path.split('/').pop() ?? path);
    return folder;
}

function addFile(folder: TFolder, path: string): TFile {
    const file = createTestTFile(path);
    file.parent = folder;
    file.stat = {
        ctime: 0,
        mtime: 0,
        size: 0
    };
    (folder as TFolder & { children: Array<TFolder | TFile> }).children.push(file);
    return file;
}

function createAppWithFrontmatter(frontmatterByPath: ReadonlyMap<string, Record<string, unknown>>): App {
    const app = new App();
    app.metadataCache.getFileCache = (file: TFile) => ({
        frontmatter: frontmatterByPath.get(file.path)
    });
    return app;
}

function createManualSortSettings(overrides: Partial<NotebookNavigatorSettings> = {}): NotebookNavigatorSettings {
    return {
        ...DEFAULT_SETTINGS,
        defaultFolderSort: 'property-asc',
        folderSortOverrides: {
            notes: { option: 'property-asc', propertyKey: 'sort_index' }
        },
        manualSortPropertyKey: 'sort_index',
        pinnedNotes: {},
        ...overrides
    };
}

describe('sequential reading order', () => {
    it('returns pinned markdown first, then complete hierarchy DFS, excluding non-markdown files', () => {
        const folder = createFolder('notes');
        const pinned = addFile(folder, 'notes/pinned.md');
        const parent = addFile(folder, 'notes/parent.md');
        const child = addFile(folder, 'notes/child.md');
        const grandchild = addFile(folder, 'notes/grandchild.md');
        const sibling = addFile(folder, 'notes/sibling.md');
        addFile(folder, 'notes/diagram.pg');

        const rankByPath = new Map<string, Record<string, unknown>>([
            [pinned.path, { sort_index: 5 }],
            [child.path, { sort_index: 20 }],
            [parent.path, { sort_index: 10 }],
            [grandchild.path, { sort_index: 30 }],
            [sibling.path, { sort_index: 40 }]
        ]);
        const app = createAppWithFrontmatter(rankByPath);
        const settings = createManualSortSettings({
            pinnedNotes: {
                [pinned.path]: {
                    folder: true,
                    property: true,
                    tag: true
                }
            }
        });

        const ordered = computeSequentialReadingOrder({
            app,
            folder,
            hierarchyParentByPath: new Map([
                [child.path, parent.path],
                [grandchild.path, child.path]
            ]),
            settings,
            visibility: {
                includeDescendantNotes: false,
                showHiddenItems: false
            }
        });

        expect(ordered.map(file => file.path)).toEqual([pinned.path, parent.path, child.path, grandchild.path, sibling.path]);
    });

    it('falls back to the current sorted markdown order when hierarchy is inactive', () => {
        const folder = createFolder('notes');
        const first = addFile(folder, 'notes/first.md');
        const second = addFile(folder, 'notes/second.md');
        const app = createAppWithFrontmatter(
            new Map([
                [first.path, { sort_index: 20 }],
                [second.path, { sort_index: 10 }]
            ])
        );

        const ordered = computeSequentialReadingOrder({
            app,
            folder,
            hierarchyParentByPath: new Map([[second.path, first.path]]),
            settings: createManualSortSettings({
                folderSortOverrides: {
                    notes: 'title-asc'
                }
            }),
            visibility: {
                includeDescendantNotes: false,
                showHiddenItems: false
            }
        });

        expect(ordered.map(file => file.path)).toEqual([first.path, second.path]);
    });
});

describe('sequential reading frontmatter splitting', () => {
    it('splits and rejoins markdown with frontmatter', () => {
        const parts = splitMarkdownFrontmatter('---\ntags:\n  - work\n---\n\nBody');

        expect(parts).toEqual({
            body: '\nBody',
            hasFrontmatter: true,
            prefix: '---\ntags:\n  - work\n---\n'
        });
        expect(joinMarkdownFrontmatter(parts, 'Updated')).toBe('---\ntags:\n  - work\n---\nUpdated');
    });

    it('preserves BOM and CRLF frontmatter', () => {
        const parts = splitMarkdownFrontmatter('\uFEFF---\r\ntitle: Test\r\n---\r\nBody');

        expect(parts.body).toBe('Body');
        expect(parts.hasFrontmatter).toBe(true);
        expect(joinMarkdownFrontmatter(parts, 'Next')).toBe('\uFEFF---\r\ntitle: Test\r\n---\r\nNext');
    });

    it('does not swallow text when frontmatter is not closed', () => {
        const content = '---\ntitle: not closed\nBody';
        const parts = splitMarkdownFrontmatter(content);

        expect(parts).toEqual({
            body: content,
            hasFrontmatter: false,
            prefix: ''
        });
    });

    it('does not treat body separators as frontmatter', () => {
        const content = 'Intro\n---\nBody';
        const parts = splitMarkdownFrontmatter(content);

        expect(parts).toEqual({
            body: content,
            hasFrontmatter: false,
            prefix: ''
        });
    });
});

describe('saveSequentialReadingSection', () => {
    it('writes only the edited body while preserving frontmatter', async () => {
        const file = createTestTFile('notes/source.md');
        const read = vi.fn(async () => '---\naliases: [source]\n---\nOriginal');
        const modify = vi.fn(async () => {});
        const vault = { modify, read } as unknown as Pick<Vault, 'modify' | 'read'>;

        await saveSequentialReadingSection(vault, file, 'Updated');

        expect(read).toHaveBeenCalledWith(file);
        expect(modify).toHaveBeenCalledTimes(1);
        expect(modify).toHaveBeenCalledWith(file, '---\naliases: [source]\n---\nUpdated');
    });

    it('saves an empty body without adding section divider text', async () => {
        const file = createTestTFile('notes/empty.md');
        const read = vi.fn(async () => '');
        const modify = vi.fn(async () => {});
        const vault = { modify, read } as unknown as Pick<Vault, 'modify' | 'read'>;

        await saveSequentialReadingSection(vault, file, '');

        expect(modify).toHaveBeenCalledWith(file, '');
    });
});

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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, TFile, type CachedMetadata } from 'obsidian';
import { FileMetadataService } from '../../src/services/metadata/FileMetadataService';
import { DEFAULT_SETTINGS } from '../../src/settings/defaultSettings';
import type { NotebookNavigatorSettings } from '../../src/settings';
import type { ISettingsProvider } from '../../src/interfaces/ISettingsProvider';
import { extractMetadataFromCache } from '../../src/utils/metadataExtractor';

const updateFileMetadata = vi.fn();

vi.mock('../../src/storage/fileOperations', () => ({
    getDBInstance: () => ({
        updateFileMetadata
    })
}));

class TestSettingsProvider implements ISettingsProvider {
    constructor(public settings: NotebookNavigatorSettings) {}

    saveSettingsAndUpdate = vi.fn().mockResolvedValue(undefined);

    notifySettingsUpdate(): void {}

    getRecentNotes(): string[] {
        return [];
    }

    setRecentNotes(): void {}

    getRecentIcons(): Record<string, string[]> {
        return {};
    }

    setRecentIcons(): void {}

    getRecentColors(): string[] {
        return [];
    }

    setRecentColors(): void {}
}

function createSettings(): NotebookNavigatorSettings {
    return {
        ...DEFAULT_SETTINGS,
        useFrontmatterMetadata: true,
        frontmatterIconField: 'icon',
        fileIcons: {},
        fileColors: {}
    };
}

describe('FileMetadataService frontmatter integration', () => {
    let app: App;
    let service: FileMetadataService;
    let settingsProvider: TestSettingsProvider;
    let file: TFile;
    let frontmatter: Record<string, unknown>;
    const processFrontMatter = vi.fn();
    const getAbstractFileByPath = vi.fn();

    beforeEach(() => {
        updateFileMetadata.mockReset();
        updateFileMetadata.mockResolvedValue(undefined);
        processFrontMatter.mockReset();
        getAbstractFileByPath.mockReset();

        const settings = createSettings();
        settingsProvider = new TestSettingsProvider(settings);

        file = new TFile();
        file.path = 'Vault/Note.md';
        file.extension = 'md';
        frontmatter = {};

        processFrontMatter.mockImplementation((_tfile: TFile, callback: (fm: Record<string, unknown>) => void) => {
            callback(frontmatter);
            return Promise.resolve();
        });
        getAbstractFileByPath.mockImplementation((path: string) => (path === file.path ? file : null));

        app = new App();
        app.vault.getAbstractFileByPath = getAbstractFileByPath;
        app.fileManager.processFrontMatter = processFrontMatter;

        service = new FileMetadataService(app, settingsProvider);
    });

    it('saves phosphor icons in Iconize format and extracts canonical metadata', async () => {
        await service.setFileIcon(file.path, 'phosphor:ph-apple-logo');

        expect(processFrontMatter).toHaveBeenCalledTimes(1);
        expect(frontmatter.icon).toBe('PhAppleLogo');
        expect(updateFileMetadata).toHaveBeenCalledWith(file.path, { icon: 'phosphor:apple-logo' });

        const metadata = extractMetadataFromCache({ frontmatter: { icon: frontmatter.icon } } as CachedMetadata, settingsProvider.settings);
        expect(metadata.icon).toBe('phosphor:apple-logo');
    });

    it('pins notes in a single settings update', async () => {
        settingsProvider.settings.pinnedNotes = {};

        const pinnedCount = await service.pinNotes(['Vault/One.md', 'Vault/Two.md'], 'folder');

        expect(pinnedCount).toBe(2);
        expect(settingsProvider.saveSettingsAndUpdate).toHaveBeenCalledTimes(1);
        expect(settingsProvider.settings.pinnedNotes?.['Vault/One.md']).toEqual({ folder: true, tag: false, property: false });
        expect(settingsProvider.settings.pinnedNotes?.['Vault/Two.md']).toEqual({ folder: true, tag: false, property: false });
    });

    it('counts only newly pinned notes in folder context', async () => {
        settingsProvider.settings.pinnedNotes = {
            'Vault/One.md': { folder: true, tag: false, property: false }
        };

        const pinnedCount = await service.pinNotes(['Vault/One.md', 'Vault/Two.md'], 'folder');

        expect(pinnedCount).toBe(1);
        expect(settingsProvider.settings.pinnedNotes?.['Vault/One.md']).toEqual({ folder: true, tag: false, property: false });
        expect(settingsProvider.settings.pinnedNotes?.['Vault/Two.md']).toEqual({ folder: true, tag: false, property: false });
    });

    it('pins notes in property context', async () => {
        settingsProvider.settings.pinnedNotes = {};

        const pinnedCount = await service.pinNotes(['Vault/One.md'], 'property');

        expect(pinnedCount).toBe(1);
        expect(settingsProvider.settings.pinnedNotes?.['Vault/One.md']).toEqual({ folder: false, tag: false, property: true });
    });

    it('toggles pins only within the selected tag view', async () => {
        settingsProvider.settings.pinnedTagOrderByTag = {};

        await service.togglePinnedInTagView('Vault/One.md', 'Projects/Alpha');

        expect(service.isPinnedInTagView('Vault/One.md', 'projects/alpha')).toBe(true);
        expect(service.isPinnedInTagView('Vault/One.md', 'projects/beta')).toBe(false);
        expect(settingsProvider.settings.pinnedTagOrderByTag).toEqual({
            'projects/alpha': ['Vault/One.md']
        });

        await service.togglePinnedInTagView('Vault/One.md', 'Projects/Alpha');

        expect(service.isPinnedInTagView('Vault/One.md', 'projects/alpha')).toBe(false);
    });

    it('reorders pinned files within a tag view and persists order', async () => {
        settingsProvider.settings.pinnedTagOrderByTag = {
            projects: ['Vault/One.md', 'Vault/Two.md']
        };

        await service.reorderPinnedInTagView('Projects', ['Vault/Two.md', 'Vault/One.md']);

        expect(service.getPinnedTagOrder('projects')).toEqual(['Vault/Two.md', 'Vault/One.md']);
    });

    it('updates pinned tag order when files are renamed or deleted', async () => {
        settingsProvider.settings.pinnedTagOrderByTag = {
            projects: ['Vault/One.md', 'Vault/Two.md']
        };

        await service.handleFileRename('Vault/One.md', 'Vault/Renamed.md');
        expect(service.getPinnedTagOrder('projects')).toEqual(['Vault/Renamed.md', 'Vault/Two.md']);

        await service.handleFileDelete('Vault/Two.md');
        expect(service.getPinnedTagOrder('projects')).toEqual(['Vault/Renamed.md']);
    });

    it('treats legacy folder+tag pins as pinned in property context', () => {
        settingsProvider.settings.pinnedNotes = {
            'Vault/Legacy.md': { folder: true, tag: true }
        } as unknown as NotebookNavigatorSettings['pinnedNotes'];

        expect(service.isPinned('Vault/Legacy.md', 'property')).toBe(true);
    });

    it('unpins legacy folder+tag pins from property context on toggle', async () => {
        settingsProvider.settings.pinnedNotes = {
            'Vault/Legacy.md': { folder: true, tag: true }
        } as unknown as NotebookNavigatorSettings['pinnedNotes'];

        await service.togglePinnedNote('Vault/Legacy.md', 'property');

        expect(settingsProvider.settings.pinnedNotes?.['Vault/Legacy.md']).toEqual({ folder: true, tag: true, property: false });
    });

    it('does not count legacy folder+tag pins as newly pinned in property context', async () => {
        settingsProvider.settings.pinnedNotes = {
            'Vault/Legacy.md': { folder: true, tag: true }
        } as unknown as NotebookNavigatorSettings['pinnedNotes'];

        const pinnedCount = await service.pinNotes(['Vault/Legacy.md'], 'property');

        expect(pinnedCount).toBe(0);
    });
});

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

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { HierarchyService } from '../../src/services/hierarchy/HierarchyService';

const TEST_CONFIG_DIR = 'test-config';
const TEST_HIERARCHY_DATA_PATH = `${TEST_CONFIG_DIR}/plugins/notebook-navigator/hierarchy.json`;
const activeServices: HierarchyService[] = [];

function createApp(initialFiles: Record<string, string> = {}) {
    const files = new Map(Object.entries(initialFiles));
    const adapter = {
        exists: vi.fn(async (path: string) => files.has(path) || path === `${TEST_CONFIG_DIR}/plugins/notebook-navigator`),
        read: vi.fn(async (path: string) => files.get(path) ?? ''),
        write: vi.fn(async (path: string, content: string) => {
            files.set(path, content);
        }),
        mkdir: vi.fn(async (path: string) => {
            files.set(path, '');
        })
    };

    return {
        app: {
            vault: {
                configDir: TEST_CONFIG_DIR,
                adapter
            }
        } as unknown as App,
        adapter,
        files
    };
}

function createHierarchyService(app: App): HierarchyService {
    const service = new HierarchyService(app);
    activeServices.push(service);
    return service;
}

afterEach(() => {
    activeServices.splice(0).forEach(service => {
        service.dispose();
    });
});

describe('HierarchyService', () => {
    it('loads an empty hierarchy when hierarchy.json is missing', async () => {
        const { app } = createApp();
        const service = createHierarchyService(app);

        await service.load();

        expect(service.getParent('notes/child.md')).toBeNull();
        expect(service.getChildren('notes/parent.md')).toEqual([]);
    });

    it('loads an empty hierarchy when hierarchy.json is invalid', async () => {
        const { app } = createApp({ [TEST_HIERARCHY_DATA_PATH]: '{bad json' });
        const service = createHierarchyService(app);

        await service.load();

        expect(service.getParentEntries().size).toBe(0);
    });

    it('sets parents, persists the envelope, and notifies subscribers', async () => {
        const { app, files } = createApp();
        const service = createHierarchyService(app);
        const listener = vi.fn();
        service.subscribe(listener);

        await service.load();
        const result = service.setParent('notes/child.md', 'notes/parent.md');
        await service.flush();

        expect(result.ok).toBe(true);
        expect(service.getParent('notes/child.md')).toBe('notes/parent.md');
        expect(service.getChildren('notes/parent.md')).toEqual(['notes/child.md']);
        const saved = JSON.parse(files.get(TEST_HIERARCHY_DATA_PATH) ?? '{}') as { version: number; parents: Record<string, string> };
        expect(saved.version).toBe(1);
        expect(saved.parents).toEqual({ 'notes/child.md': 'notes/parent.md' });
        expect(listener).toHaveBeenCalled();
    });

    it('rejects self and descendant parent assignments', async () => {
        const { app } = createApp();
        const service = createHierarchyService(app);
        await service.load();

        expect(service.setParent('notes/a.md', 'notes/a.md')).toEqual({ ok: false, reason: 'self' });
        expect(service.setParent('notes/b.md', 'notes/a.md')).toEqual({ ok: true });
        expect(service.setParent('notes/c.md', 'notes/b.md')).toEqual({ ok: true });
        expect(service.setParent('notes/a.md', 'notes/c.md')).toEqual({ ok: false, reason: 'cycle' });
    });

    it('renames child and parent paths', async () => {
        const { app } = createApp();
        const service = createHierarchyService(app);
        await service.load();
        service.setParent('notes/child.md', 'notes/parent.md');
        service.setParent('notes/grandchild.md', 'notes/child.md');

        service.applyRename('notes/child.md', 'notes/renamed-child.md');

        expect(service.getParent('notes/child.md')).toBeNull();
        expect(service.getParent('notes/renamed-child.md')).toBe('notes/parent.md');
        expect(service.getParent('notes/grandchild.md')).toBe('notes/renamed-child.md');
    });

    it('deletes a node and promotes its children to root', async () => {
        const { app } = createApp();
        const service = createHierarchyService(app);
        await service.load();
        service.setParent('notes/child.md', 'notes/parent.md');
        service.setParent('notes/grandchild.md', 'notes/child.md');

        service.applyDelete('notes/child.md');

        expect(service.getParent('notes/child.md')).toBeNull();
        expect(service.getParent('notes/grandchild.md')).toBeNull();
        expect(service.getChildren('notes/parent.md')).toEqual([]);
    });
});

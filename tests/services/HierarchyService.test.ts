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
import { HierarchyService } from '../../src/services/hierarchy/HierarchyService';
import type { NoteHierarchyData } from '../../src/settings/types';

const activeServices: HierarchyService[] = [];

function createStore(initialData?: unknown) {
    let data = initialData;
    const saveData = vi.fn(async (nextData: NoteHierarchyData) => {
        data = nextData;
    });

    return {
        loadData: () => data,
        saveData,
        getData: () => data
    };
}

function createHierarchyService(initialData?: unknown) {
    const store = createStore(initialData);
    const service = new HierarchyService({
        loadData: store.loadData,
        saveData: store.saveData
    });
    activeServices.push(service);
    return { service, store };
}

afterEach(() => {
    activeServices.splice(0).forEach(service => {
        service.dispose();
    });
});

describe('HierarchyService', () => {
    it('loads an empty hierarchy when noteHierarchy is missing', async () => {
        const { service } = createHierarchyService();

        await service.load();

        expect(service.getParent('notes/child.md')).toBeNull();
        expect(service.getChildren('notes/parent.md')).toEqual([]);
    });

    it('loads an empty hierarchy when noteHierarchy is invalid', async () => {
        const { service } = createHierarchyService('bad data');

        await service.load();

        expect(service.getParentEntries().size).toBe(0);
    });

    it('loads parents from noteHierarchy data', async () => {
        const { service } = createHierarchyService({
            version: 1,
            parents: { 'notes/child.md': 'notes/parent.md' },
            updatedAt: 1
        });

        await service.load();

        expect(service.getParent('notes/child.md')).toBe('notes/parent.md');
        expect(service.getChildren('notes/parent.md')).toEqual(['notes/child.md']);
    });

    it('sets parents, persists the envelope, and notifies subscribers', async () => {
        const { service, store } = createHierarchyService();
        const listener = vi.fn();
        service.subscribe(listener);

        await service.load();
        const result = service.setParent('notes/child.md', 'notes/parent.md');
        await service.flush();

        expect(result.ok).toBe(true);
        expect(service.getParent('notes/child.md')).toBe('notes/parent.md');
        expect(service.getChildren('notes/parent.md')).toEqual(['notes/child.md']);
        const saved = store.getData() as NoteHierarchyData;
        expect(saved.version).toBe(1);
        expect(saved.parents).toEqual({ 'notes/child.md': 'notes/parent.md' });
        expect(store.saveData).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalled();
    });

    it('rejects self and descendant parent assignments', async () => {
        const { service } = createHierarchyService();
        await service.load();

        expect(service.setParent('notes/a.md', 'notes/a.md')).toEqual({ ok: false, reason: 'self' });
        expect(service.setParent('notes/b.md', 'notes/a.md')).toEqual({ ok: true });
        expect(service.setParent('notes/c.md', 'notes/b.md')).toEqual({ ok: true });
        expect(service.setParent('notes/a.md', 'notes/c.md')).toEqual({ ok: false, reason: 'cycle' });
    });

    it('renames child and parent paths', async () => {
        const { service } = createHierarchyService();
        await service.load();
        service.setParent('notes/child.md', 'notes/parent.md');
        service.setParent('notes/grandchild.md', 'notes/child.md');

        service.applyRename('notes/child.md', 'notes/renamed-child.md');

        expect(service.getParent('notes/child.md')).toBeNull();
        expect(service.getParent('notes/renamed-child.md')).toBe('notes/parent.md');
        expect(service.getParent('notes/grandchild.md')).toBe('notes/renamed-child.md');
    });

    it('deletes a node and promotes its children to root', async () => {
        const { service } = createHierarchyService();
        await service.load();
        service.setParent('notes/child.md', 'notes/parent.md');
        service.setParent('notes/grandchild.md', 'notes/child.md');

        service.applyDelete('notes/child.md');

        expect(service.getParent('notes/child.md')).toBeNull();
        expect(service.getParent('notes/grandchild.md')).toBeNull();
        expect(service.getChildren('notes/parent.md')).toEqual([]);
    });
});

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

import type { NoteHierarchyData } from '../../settings/types';
import { isRecord } from '../../utils/typeGuards';

const HIERARCHY_SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 150;

export interface HierarchySetParentResult {
    ok: boolean;
    reason?: 'self' | 'cycle';
}

type HierarchyListener = () => void;

interface HierarchyServiceOptions {
    loadData: () => unknown;
    saveData: (data: NoteHierarchyData) => Promise<void>;
}

function normalizeParents(value: unknown): Map<string, string> {
    if (!isRecord(value)) {
        return new Map();
    }

    const parents = new Map<string, string>();
    Object.entries(value).forEach(([childPath, parentPath]) => {
        if (typeof childPath === 'string' && childPath.length > 0 && typeof parentPath === 'string' && parentPath.length > 0) {
            parents.set(childPath, parentPath);
        }
    });
    return parents;
}

export class HierarchyService {
    private readonly listeners = new Set<HierarchyListener>();
    private parents = new Map<string, string>();
    private childrenByParent = new Map<string, Set<string>>();
    private saveTimer: number | null = null;
    private notifyQueued = false;
    private version = 0;
    private isDisposed = false;

    constructor(private readonly options: HierarchyServiceOptions) {}

    async load(): Promise<void> {
        if (this.isDisposed) {
            return;
        }

        try {
            const parsed = this.options.loadData();
            if (parsed === null || parsed === undefined) {
                this.replaceParents(new Map());
                this.bumpVersion();
                return;
            }

            if (!isRecord(parsed)) {
                console.warn('Notebook Navigator noteHierarchy data is invalid; using empty hierarchy.');
                this.replaceParents(new Map());
                this.bumpVersion();
                return;
            }

            const envelope = parsed as Partial<NoteHierarchyData>;
            if (envelope.version !== HIERARCHY_SCHEMA_VERSION) {
                console.warn('Unsupported Notebook Navigator noteHierarchy version; using empty hierarchy.');
                this.replaceParents(new Map());
                this.bumpVersion();
                return;
            }

            this.replaceParents(normalizeParents(envelope.parents));
            this.bumpVersion();
        } catch (error) {
            console.warn('Failed to load Notebook Navigator noteHierarchy data; using empty hierarchy.', error);
            this.replaceParents(new Map());
            this.bumpVersion();
        }
    }

    dispose(): void {
        this.isDisposed = true;
        if (this.saveTimer !== null && typeof window !== 'undefined') {
            window.clearTimeout(this.saveTimer);
        }
        this.saveTimer = null;
        this.listeners.clear();
    }

    subscribe(listener: HierarchyListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    getVersion(): number {
        return this.version;
    }

    getParent(path: string): string | null {
        return this.parents.get(path) ?? null;
    }

    getParentEntries(): ReadonlyMap<string, string> {
        return this.parents;
    }

    getChildren(path: string): string[] {
        return Array.from(this.childrenByParent.get(path) ?? []);
    }

    getDescendants(path: string): Set<string> {
        const descendants = new Set<string>();
        const stack = this.getChildren(path);
        while (stack.length > 0) {
            const childPath = stack.pop();
            if (!childPath || descendants.has(childPath)) {
                continue;
            }
            descendants.add(childPath);
            stack.push(...this.getChildren(childPath));
        }
        return descendants;
    }

    isDescendant(ancestorPath: string, candidatePath: string): boolean {
        if (!ancestorPath || !candidatePath) {
            return false;
        }
        let current: string | null = candidatePath;
        const visited = new Set<string>();
        while (current) {
            if (current === ancestorPath) {
                return true;
            }
            if (visited.has(current)) {
                return false;
            }
            visited.add(current);
            current = this.getParent(current);
        }
        return false;
    }

    setParent(childPath: string, parentPath: string | null): HierarchySetParentResult {
        if (parentPath === childPath) {
            return { ok: false, reason: 'self' };
        }
        if (parentPath && this.isDescendant(childPath, parentPath)) {
            return { ok: false, reason: 'cycle' };
        }

        const currentParent = this.parents.get(childPath) ?? null;
        if (currentParent === parentPath) {
            return { ok: true };
        }

        if (parentPath) {
            this.parents.set(childPath, parentPath);
        } else {
            this.parents.delete(childPath);
        }
        this.rebuildChildrenIndex();
        this.scheduleSave();
        this.bumpVersion();
        return { ok: true };
    }

    applyRename(oldPath: string, newPath: string): void {
        if (oldPath === newPath) {
            return;
        }

        let changed = false;
        const nextParents = new Map<string, string>();
        this.parents.forEach((parentPath, childPath) => {
            const nextChildPath = childPath === oldPath ? newPath : childPath;
            const nextParentPath = parentPath === oldPath ? newPath : parentPath;
            if (nextChildPath !== childPath || nextParentPath !== parentPath) {
                changed = true;
            }
            if (nextChildPath !== nextParentPath) {
                nextParents.set(nextChildPath, nextParentPath);
            }
        });

        if (!changed) {
            return;
        }

        this.replaceParents(nextParents);
        this.scheduleSave();
        this.bumpVersion();
    }

    applyDelete(path: string): void {
        let changed = false;
        const nextParents = new Map<string, string>();
        this.parents.forEach((parentPath, childPath) => {
            if (childPath === path || parentPath === path) {
                changed = true;
                return;
            }
            nextParents.set(childPath, parentPath);
        });

        if (!changed) {
            return;
        }

        this.replaceParents(nextParents);
        this.scheduleSave();
        this.bumpVersion();
    }

    async flush(): Promise<void> {
        if (this.saveTimer !== null && typeof window !== 'undefined') {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        await this.writeNow();
    }

    private replaceParents(parents: Map<string, string>): void {
        this.parents = parents;
        this.rebuildChildrenIndex();
    }

    private rebuildChildrenIndex(): void {
        const nextChildren = new Map<string, Set<string>>();
        this.parents.forEach((parentPath, childPath) => {
            const children = nextChildren.get(parentPath) ?? new Set<string>();
            children.add(childPath);
            nextChildren.set(parentPath, children);
        });
        this.childrenByParent = nextChildren;
    }

    private scheduleSave(): void {
        if (this.isDisposed) {
            return;
        }
        if (typeof window === 'undefined') {
            void this.writeNow();
            return;
        }
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
        }
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.writeNow();
        }, SAVE_DEBOUNCE_MS);
    }

    private async writeNow(): Promise<void> {
        if (this.isDisposed) {
            return;
        }

        const envelope: NoteHierarchyData = {
            version: HIERARCHY_SCHEMA_VERSION,
            parents: Object.fromEntries(this.parents),
            updatedAt: Date.now()
        };

        try {
            await this.options.saveData(envelope);
        } catch (error) {
            console.error('Failed to save Notebook Navigator noteHierarchy data', error);
        }
    }

    private bumpVersion(): void {
        this.version += 1;
        this.queueNotify();
    }

    private queueNotify(): void {
        if (this.notifyQueued) {
            return;
        }
        this.notifyQueued = true;
        queueMicrotask(() => {
            this.notifyQueued = false;
            this.listeners.forEach(listener => listener());
        });
    }
}

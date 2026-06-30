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

import { describe, expect, it } from 'vitest';
import { canAttachNoteTreeSelectionToParent, getTopLevelSelectedNoteTreePaths } from '../../src/utils/noteTreeDrag';

const parents = new Map<string, string>([
    ['A1.md', 'A.md'],
    ['A2.md', 'A.md'],
    ['A1a.md', 'A1.md'],
    ['B1.md', 'B.md']
]);

function getParent(path: string): string | null {
    return parents.get(path) ?? null;
}

function isDescendant(ancestorPath: string, candidatePath: string): boolean {
    let current: string | null = candidatePath;
    while (current) {
        if (current === ancestorPath) {
            return true;
        }
        current = getParent(current);
    }
    return false;
}

describe('note tree drag helpers', () => {
    it('keeps only top-level selected paths so internal child relationships are preserved', () => {
        const selected = new Set(['A.md', 'A1.md', 'A1a.md', 'B.md']);

        expect(getTopLevelSelectedNoteTreePaths(selected, getParent)).toEqual(new Set(['A.md', 'B.md']));
    });

    it('treats selected children as roots when their parent is not selected', () => {
        const selected = new Set(['A1.md', 'B.md']);

        expect(getTopLevelSelectedNoteTreePaths(selected, getParent)).toEqual(new Set(['A1.md', 'B.md']));
    });

    it('rejects attaching a selection to itself or one of its descendants', () => {
        const selected = new Set(['A.md', 'B.md']);

        expect(canAttachNoteTreeSelectionToParent(selected, 'A.md', isDescendant)).toBe(false);
        expect(canAttachNoteTreeSelectionToParent(selected, 'A1a.md', isDescendant)).toBe(false);
        expect(canAttachNoteTreeSelectionToParent(selected, 'X.md', isDescendant)).toBe(true);
    });
});

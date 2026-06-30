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
import { renameExpandedNoteTreeNodeKeys } from '../../src/context/ExpansionContext';

describe('renameExpandedNoteTreeNodeKeys', () => {
    it('preserves expanded note tree nodes when a parent note is renamed in place', () => {
        const expanded = new Set(['notes\u0001notes/Parent.md', 'notes\u0001notes/Child.md']);

        const renamed = renameExpandedNoteTreeNodeKeys(expanded, 'notes/Parent.md', 'notes/Renamed parent.md');

        expect(renamed).toEqual(new Set(['notes\u0001notes/Renamed parent.md', 'notes\u0001notes/Child.md']));
    });

    it('moves the note tree scope when a renamed note changes folders', () => {
        const expanded = new Set(['notes\u0001notes/Parent.md']);

        const renamed = renameExpandedNoteTreeNodeKeys(expanded, 'notes/Parent.md', 'archive/Parent.md');

        expect(renamed).toEqual(new Set(['archive\u0001archive/Parent.md']));
    });

    it('returns null when no expanded node references the renamed path', () => {
        const expanded = new Set(['notes\u0001notes/Other.md']);

        const renamed = renameExpandedNoteTreeNodeKeys(expanded, 'notes/Parent.md', 'notes/Renamed parent.md');

        expect(renamed).toBeNull();
    });
});

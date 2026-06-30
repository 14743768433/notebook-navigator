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

export function getTopLevelSelectedNoteTreePaths(
    selectedPaths: ReadonlySet<string>,
    getParent: (path: string) => string | null
): Set<string> {
    const topLevelPaths = new Set<string>();
    selectedPaths.forEach(path => {
        const parentPath = getParent(path);
        if (!parentPath || !selectedPaths.has(parentPath)) {
            topLevelPaths.add(path);
        }
    });
    return topLevelPaths;
}

export function canAttachNoteTreeSelectionToParent(
    selectedPaths: ReadonlySet<string>,
    targetParentPath: string | null,
    isDescendant: (ancestorPath: string, candidatePath: string) => boolean
): boolean {
    if (!targetParentPath) {
        return true;
    }

    if (selectedPaths.has(targetParentPath)) {
        return false;
    }

    for (const path of selectedPaths) {
        if (path === targetParentPath || isDescendant(path, targetParentPath)) {
            return false;
        }
    }

    return true;
}

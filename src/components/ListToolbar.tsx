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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSelectionState } from '../context/SelectionContext';
import { useServices } from '../context/ServicesContext';
import { useSettingsState } from '../context/SettingsContext';
import { useUXPreferences } from '../context/UXPreferencesContext';
import { strings } from '../i18n';
import { ServiceIcon } from './ServiceIcon';
import { useListActions } from '../hooks/useListActions';
import { runAsyncAction } from '../utils/async';
import { resolveUXIcon } from '../utils/uxIcons';
import type { ManualSortNewFilePlacementContext } from '../utils/manualSort';
import { ItemType } from '../types';

interface ListToolbarProps {
    isSearchActive?: boolean;
    onSearchToggle?: () => void;
    getManualSortNewFileContext?: () => ManualSortNewFilePlacementContext | null;
    useFloatingLayout?: boolean;
}

let sequentialReadingToolbarListenerCounter = 0;

export function ListToolbar({ isSearchActive, onSearchToggle, getManualSortNewFileContext, useFloatingLayout = false }: ListToolbarProps) {
    const sequentialReadingListenerIdRef = useRef<string | null>(null);
    if (!sequentialReadingListenerIdRef.current) {
        sequentialReadingToolbarListenerCounter += 1;
        sequentialReadingListenerIdRef.current = `list-toolbar-sequential-reading-${sequentialReadingToolbarListenerCounter}`;
    }
    const uxPreferences = useUXPreferences();
    const includeDescendantNotes = uxPreferences.includeDescendantNotes;
    const selectionState = useSelectionState();
    const { plugin } = useServices();
    const settings = useSettingsState();
    const listVisibility = settings.toolbarVisibility.list;
    const showRevealButton = listVisibility.reveal;

    // Use the shared actions hook
    const {
        handleNewFile,
        canCreateNewFile,
        handleRevealFile,
        canRevealFile,
        handleAppearanceMenu,
        handleSortMenu,
        handleToggleDescendants,
        descendantsTooltip,
        getSortIcon,
        hasAppearanceOrSortSelection,
        hasCustomSortOrGroup,
        hasCustomAppearance
    } = useListActions({ getManualSortNewFileContext, trackRevealFileAvailability: showRevealButton });

    const showSearchButton = listVisibility.search;
    const showDescendantsButton = listVisibility.descendants;
    const showSortButton = listVisibility.sort;
    const showAppearanceButton = listVisibility.appearance;
    const showNewNoteButton = listVisibility.newNote;
    const hasNavigationSelection = Boolean(selectionState.selectedFolder || selectionState.selectedTag || selectionState.selectedProperty);
    const selectedFolder = selectionState.selectionType === ItemType.FOLDER ? selectionState.selectedFolder : null;
    const showSequentialReadingButton = Boolean(selectedFolder);
    const [sequentialReadingStateVersion, setSequentialReadingStateVersion] = useState(0);
    const isSequentialReadingActive = useMemo(() => {
        void sequentialReadingStateVersion;
        return selectedFolder !== null && plugin.isSequentialReadingOpenForFolder(selectedFolder.path);
    }, [plugin, selectedFolder, sequentialReadingStateVersion]);
    const canToggleSequentialReading = selectedFolder !== null && (!isSearchActive || isSequentialReadingActive);

    useEffect(() => {
        const listenerId = sequentialReadingListenerIdRef.current;
        if (!listenerId) {
            return;
        }

        plugin.registerSequentialReadingStateListener(listenerId, () => {
            setSequentialReadingStateVersion(version => version + 1);
        });

        return () => {
            plugin.unregisterSequentialReadingStateListener(listenerId);
        };
    }, [plugin]);

    const leftButtonCount = [
        showSearchButton,
        showRevealButton,
        showSequentialReadingButton,
        showDescendantsButton,
        showSortButton,
        showAppearanceButton
    ].filter(Boolean).length;
    const totalButtonCount = leftButtonCount + (showNewNoteButton ? 1 : 0);
    const leftGroupClassName = leftButtonCount === 1 ? 'nn-mobile-toolbar-circle' : 'nn-mobile-toolbar-pill';
    const leftButtonBaseClassName =
        leftButtonCount === 1 ? 'nn-mobile-toolbar-button nn-mobile-toolbar-button-circle' : 'nn-mobile-toolbar-button';

    if (totalButtonCount === 0) {
        return null;
    }

    const leftButtons = [
        showSearchButton ? (
            <button
                key="search"
                className={`${leftButtonBaseClassName}${isSearchActive ? ' nn-mobile-toolbar-button-active' : ''}`}
                aria-label={strings.paneHeader.search}
                onClick={onSearchToggle}
                disabled={!hasNavigationSelection}
                tabIndex={-1}
            >
                <ServiceIcon iconId={resolveUXIcon(settings.interfaceIcons, 'list-search')} />
            </button>
        ) : null,
        showRevealButton ? (
            <button
                key="reveal"
                className={leftButtonBaseClassName}
                aria-label={strings.commands.revealFile}
                onClick={() => {
                    runAsyncAction(() => handleRevealFile());
                }}
                disabled={!canRevealFile}
                tabIndex={-1}
            >
                <ServiceIcon iconId={resolveUXIcon(settings.interfaceIcons, 'list-reveal-file')} />
            </button>
        ) : null,
        showSequentialReadingButton ? (
            <button
                key="sequential-reading"
                className={`${leftButtonBaseClassName}${isSequentialReadingActive ? ' nn-mobile-toolbar-button-active' : ''}`}
                aria-label={
                    isSequentialReadingActive
                        ? (strings.sequentialReading?.closeFolder ?? 'Close sequential reading')
                        : (strings.sequentialReading?.openFolder ?? 'Sequential reading')
                }
                aria-pressed={isSequentialReadingActive}
                onClick={() => {
                    if (!selectedFolder) {
                        return;
                    }
                    if (isSequentialReadingActive) {
                        plugin.closeSequentialReading(selectedFolder.path);
                        return;
                    }
                    if (isSearchActive) {
                        return;
                    }
                    runAsyncAction(() => plugin.openSequentialReading(selectedFolder.path));
                }}
                disabled={!canToggleSequentialReading}
                tabIndex={-1}
            >
                <ServiceIcon iconId="book-open" />
            </button>
        ) : null,
        showDescendantsButton ? (
            <button
                key="descendants"
                className={`${leftButtonBaseClassName}${includeDescendantNotes ? ' nn-mobile-toolbar-button-active' : ''}`}
                aria-label={descendantsTooltip}
                onClick={handleToggleDescendants}
                disabled={!hasNavigationSelection}
                tabIndex={-1}
            >
                <ServiceIcon iconId={resolveUXIcon(settings.interfaceIcons, 'list-descendants')} />
            </button>
        ) : null,
        showSortButton ? (
            <button
                key="sort"
                className={`${leftButtonBaseClassName}${hasCustomSortOrGroup ? ' nn-mobile-toolbar-button-active' : ''}`}
                aria-label={strings.paneHeader.changeSortAndGroup}
                onClick={handleSortMenu}
                disabled={!hasAppearanceOrSortSelection}
                tabIndex={-1}
            >
                <ServiceIcon iconId={getSortIcon()} />
            </button>
        ) : null,
        showAppearanceButton ? (
            <button
                key="appearance"
                className={`${leftButtonBaseClassName}${hasCustomAppearance ? ' nn-mobile-toolbar-button-active' : ''}`}
                aria-label={strings.paneHeader.changeAppearance}
                onClick={handleAppearanceMenu}
                disabled={!hasAppearanceOrSortSelection}
                tabIndex={-1}
            >
                <ServiceIcon iconId={resolveUXIcon(settings.interfaceIcons, 'list-appearance')} />
            </button>
        ) : null
    ].filter(Boolean);
    const newNoteButton = showNewNoteButton ? (
        <button
            key="new-note"
            className="nn-mobile-toolbar-button nn-mobile-toolbar-button-circle"
            aria-label={strings.paneHeader.newNote}
            onClick={() => {
                runAsyncAction(() => handleNewFile());
            }}
            disabled={!canCreateNewFile}
            tabIndex={-1}
        >
            <ServiceIcon iconId={resolveUXIcon(settings.interfaceIcons, 'list-new-note')} />
        </button>
    ) : null;

    if (!useFloatingLayout) {
        return (
            <div className="nn-mobile-toolbar">
                {leftButtons}
                {newNoteButton}
            </div>
        );
    }

    return (
        <div className="nn-mobile-toolbar">
            <div className="nn-mobile-toolbar-left">
                {leftButtonCount > 0 ? <div className={leftGroupClassName}>{leftButtons}</div> : null}
            </div>

            {showNewNoteButton ? (
                <div className="nn-mobile-toolbar-right">
                    <div className="nn-mobile-toolbar-circle">{newNoteButton}</div>
                </div>
            ) : null}
        </div>
    );
}

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

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type RefObject
} from 'react';
import { TFile, debounce } from 'obsidian';
import { resolvePrimarySelectedFile, useSelectionDispatch, useSelectionState } from '../context/SelectionContext';
import { useServices } from '../context/ServicesContext';
import { useSettingsState } from '../context/SettingsContext';
import { useUIDispatch, useUIState } from '../context/UIStateContext';
import { useUXPreferences } from '../context/UXPreferencesContext';
import { useFileOpener } from './useFileOpener';
import { useMultiSelection } from './useMultiSelection';
import { TIMEOUTS } from '../types/obsidian-extended';
import { runAsyncAction } from '../utils/async';
import { isKeyboardEventContextBlocked } from '../utils/domUtils';
import { isCmdCtrlModifierPressed, isMultiSelectModifierPressed } from '../utils/keyboardOpenContext';
import { openFileInContext } from '../utils/openFileInContext';
import { getAdjacentFile } from '../utils/selectionUtils';
import type { Align } from '../types/scroll';
import { ItemType } from '../types';

export interface SelectFileOptions {
    markKeyboardNavigation?: boolean;
    markUserSelection?: boolean;
    debounceOpen?: boolean;
    suppressOpen?: boolean;
    allowSequentialReadingReveal?: boolean;
}

export interface EnsureSelectionOptions {
    openInEditor?: boolean;
    clearIfEmpty?: boolean;
    selectFallback?: boolean;
    debounceOpen?: boolean;
}

export interface EnsureSelectionResult {
    selectionStateChanged: boolean;
}

interface UseListPaneSelectionCoordinatorParams {
    rootContainerRef: RefObject<HTMLDivElement | null>;
    orderedFiles: TFile[];
    filePathToIndex: Map<string, number>;
    scrollToIndexSafely: (index: number, align: Align) => void;
}

interface UseListPaneSelectionCoordinatorResult {
    selectFileFromList: (file: TFile, options?: SelectFileOptions) => void;
    selectAdjacentFile: (direction: 'next' | 'previous') => boolean;
    ensureSelectionForCurrentFilter: (options?: EnsureSelectionOptions) => EnsureSelectionResult;
    handleFileItemClick: (file: TFile, fileIndex: number | undefined, event: ReactMouseEvent, filesOverride?: TFile[]) => void;
    handleFileItemPointerDown: (file: TFile, event: ReactPointerEvent) => void;
    handleListBackgroundPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
    lastSelectedFilePath: string | null;
    isFileSelected: (file: TFile) => boolean;
    scheduleKeyboardSelectionOpen: () => void;
    scheduleKeyboardSelectionOpenForFile: (file: TFile) => void;
    commitPendingKeyboardSelectionOpen: () => void;
}

const LIST_BACKGROUND_INTERACTIVE_SELECTOR = [
    '.nn-file',
    '.nn-list-group-header',
    '.nn-list-sticky-header',
    '.nn-empty-state',
    '.nn-list-drop-indicator',
    '.nn-drag-overlay'
].join(',');

function getPointerTargetElement(target: EventTarget | null): Element | null {
    if (typeof Element !== 'undefined' && target instanceof Element) {
        return target;
    }

    if (typeof Node !== 'undefined' && target instanceof Node) {
        return target.parentElement;
    }

    return null;
}

export function useListPaneSelectionCoordinator({
    rootContainerRef,
    orderedFiles,
    filePathToIndex,
    scrollToIndexSafely
}: UseListPaneSelectionCoordinatorParams): UseListPaneSelectionCoordinatorResult {
    const { app, commandQueue, isMobile, plugin } = useServices();
    const openFileInWorkspace = useFileOpener();
    const selectionState = useSelectionState();
    const selectionDispatch = useSelectionDispatch();
    const settings = useSettingsState();
    const uiState = useUIState();
    const uiDispatch = useUIDispatch();
    const uxPreferences = useUXPreferences();
    const isSearchActive = uxPreferences.searchActive;
    const { handleMultiSelectClick, handleRangeSelectClick, isFileSelected } = useMultiSelection();

    const isUserSelectionRef = useRef(false);
    const keyboardOpenPendingRef = useRef(false);
    const keyboardOpenRequestIdRef = useRef(0);
    const keyboardOpenFileRef = useRef<TFile | null>(null);
    const navigationPhysicalKeyOpenRef = useRef(false);
    const commitPendingKeyboardSelectionOpenRef = useRef<() => void>(() => {});
    const focusedPaneRef = useRef(uiState.focusedPane);
    const lastSelectedFilePathRef = useRef<string | null>(null);
    const selectedFilesRef = useRef(selectionState.selectedFiles);

    useEffect(() => {
        selectedFilesRef.current = selectionState.selectedFiles;
    }, [selectionState.selectedFiles]);

    const debouncedOpenFileInWorkspace = useMemo(() => {
        return debounce(
            (file: TFile, requestId: number) => {
                if (requestId !== keyboardOpenRequestIdRef.current) {
                    return;
                }

                keyboardOpenPendingRef.current = false;
                keyboardOpenFileRef.current = null;
                openFileInWorkspace(file);
            },
            TIMEOUTS.DEBOUNCE_KEYBOARD_FILE_OPEN,
            true
        );
    }, [openFileInWorkspace]);

    useEffect(() => {
        return () => {
            debouncedOpenFileInWorkspace.cancel();
        };
    }, [debouncedOpenFileInWorkspace]);

    const clearPendingKeyboardOpen = useCallback(() => {
        keyboardOpenRequestIdRef.current += 1;
        keyboardOpenPendingRef.current = false;
        keyboardOpenFileRef.current = null;
        debouncedOpenFileInWorkspace.cancel();
    }, [debouncedOpenFileInWorkspace]);

    const tryRevealSequentialReading = useCallback(
        (file: TFile): boolean => {
            if (
                isSearchActive ||
                file.extension !== 'md' ||
                selectionState.selectionType !== ItemType.FOLDER ||
                !selectionState.selectedFolder
            ) {
                return false;
            }

            return plugin.revealSequentialReadingFile(selectionState.selectedFolder.path, file.path);
        },
        [isSearchActive, plugin, selectionState.selectedFolder, selectionState.selectionType]
    );

    const selectFileFromList = useCallback(
        (file: TFile, options?: SelectFileOptions) => {
            isUserSelectionRef.current = options?.markUserSelection ?? false;
            selectionDispatch({ type: 'SET_SELECTED_FILE', file });

            if (options?.markKeyboardNavigation) {
                selectionDispatch({ type: 'SET_KEYBOARD_NAVIGATION', isKeyboardNavigation: true });
            }

            if (options?.suppressOpen) {
                clearPendingKeyboardOpen();
                return;
            }

            if (options?.debounceOpen) {
                keyboardOpenRequestIdRef.current += 1;
                const requestId = keyboardOpenRequestIdRef.current;
                keyboardOpenPendingRef.current = true;
                keyboardOpenFileRef.current = file;
                debouncedOpenFileInWorkspace(file, requestId);
                return;
            }

            clearPendingKeyboardOpen();
            if (options?.allowSequentialReadingReveal && tryRevealSequentialReading(file)) {
                return;
            }
            openFileInWorkspace(file);
        },
        [clearPendingKeyboardOpen, debouncedOpenFileInWorkspace, openFileInWorkspace, selectionDispatch, tryRevealSequentialReading]
    );

    const scheduleKeyboardOpen = useCallback(
        (file: TFile) => {
            keyboardOpenRequestIdRef.current += 1;
            const requestId = keyboardOpenRequestIdRef.current;
            keyboardOpenPendingRef.current = true;
            keyboardOpenFileRef.current = file;
            debouncedOpenFileInWorkspace(file, requestId);
        },
        [debouncedOpenFileInWorkspace]
    );

    const scheduleKeyboardSelectionOpen = useCallback(() => {
        if (settings.enterToOpenFiles) {
            return;
        }

        const primarySelectedFile = resolvePrimarySelectedFile(app, selectionState);
        const fileToOpen = primarySelectedFile ?? keyboardOpenFileRef.current;
        if (!fileToOpen) {
            return;
        }

        scheduleKeyboardOpen(fileToOpen);
    }, [app, scheduleKeyboardOpen, selectionState, settings.enterToOpenFiles]);

    const scheduleKeyboardSelectionOpenForFile = useCallback(
        (file: TFile) => {
            if (settings.enterToOpenFiles) {
                return;
            }

            scheduleKeyboardOpen(file);
        },
        [scheduleKeyboardOpen, settings.enterToOpenFiles]
    );

    const commitPendingKeyboardSelectionOpen = useCallback(() => {
        if (settings.enterToOpenFiles || !keyboardOpenPendingRef.current) {
            return;
        }

        const selectedFileToOpen = keyboardOpenFileRef.current ?? resolvePrimarySelectedFile(app, selectionState);
        if (!selectedFileToOpen) {
            return;
        }

        clearPendingKeyboardOpen();
        openFileInWorkspace(selectedFileToOpen);
    }, [app, clearPendingKeyboardOpen, openFileInWorkspace, selectionState, settings.enterToOpenFiles]);

    const primarySelectedFilePathForKeyboardOpen = useMemo(() => {
        if (selectionState.selectedFile) {
            return selectionState.selectedFile.path;
        }

        const iterator = selectionState.selectedFiles.values().next();
        return iterator.done ? null : iterator.value;
    }, [selectionState.selectedFile, selectionState.selectedFiles]);

    useEffect(() => {
        commitPendingKeyboardSelectionOpenRef.current = commitPendingKeyboardSelectionOpen;
    }, [commitPendingKeyboardSelectionOpen]);

    useEffect(() => {
        if (!keyboardOpenPendingRef.current) {
            return;
        }

        const pendingFilePath = keyboardOpenFileRef.current?.path ?? null;
        if (!pendingFilePath || pendingFilePath !== primarySelectedFilePathForKeyboardOpen) {
            clearPendingKeyboardOpen();
        }
    }, [clearPendingKeyboardOpen, primarySelectedFilePathForKeyboardOpen]);

    useEffect(() => {
        if (!settings.enterToOpenFiles || !keyboardOpenPendingRef.current) {
            return;
        }

        clearPendingKeyboardOpen();
    }, [clearPendingKeyboardOpen, settings.enterToOpenFiles]);

    useEffect(() => {
        focusedPaneRef.current = uiState.focusedPane;
        if (uiState.focusedPane !== 'navigation') {
            navigationPhysicalKeyOpenRef.current = false;
        }
    }, [uiState.focusedPane]);

    useEffect(() => {
        const resetPhysicalNavigationKeyState = () => {
            navigationPhysicalKeyOpenRef.current = false;
        };

        window.addEventListener('blur', resetPhysicalNavigationKeyState);
        return () => {
            window.removeEventListener('blur', resetPhysicalNavigationKeyState);
        };
    }, []);

    useEffect(() => {
        const container = rootContainerRef.current;
        if (!container) {
            return;
        }

        const isPhysicalNavigationKey = (event: KeyboardEvent) => {
            return event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'PageUp' || event.key === 'PageDown';
        };

        const hasDisallowedModifiers = (event: KeyboardEvent) => {
            return event.ctrlKey || event.metaKey || event.altKey;
        };

        const handleNavigationKeyDown = (event: KeyboardEvent) => {
            if (focusedPaneRef.current !== 'navigation' || isKeyboardEventContextBlocked(event) || hasDisallowedModifiers(event)) {
                navigationPhysicalKeyOpenRef.current = false;
                return;
            }

            navigationPhysicalKeyOpenRef.current = isPhysicalNavigationKey(event);
        };

        const handleNavigationKeyUp = (event: KeyboardEvent) => {
            if (focusedPaneRef.current !== 'navigation' || isKeyboardEventContextBlocked(event) || hasDisallowedModifiers(event)) {
                navigationPhysicalKeyOpenRef.current = false;
                return;
            }

            if (!isPhysicalNavigationKey(event)) {
                navigationPhysicalKeyOpenRef.current = false;
                return;
            }

            commitPendingKeyboardSelectionOpenRef.current();
            navigationPhysicalKeyOpenRef.current = false;
        };

        container.addEventListener('keydown', handleNavigationKeyDown, true);
        container.addEventListener('keyup', handleNavigationKeyUp);
        return () => {
            container.removeEventListener('keydown', handleNavigationKeyDown, true);
            container.removeEventListener('keyup', handleNavigationKeyUp);
        };
    }, [rootContainerRef]);

    const ensureSelectionForCurrentFilter = useCallback(
        (options?: EnsureSelectionOptions): EnsureSelectionResult => {
            const openInEditor = options?.openInEditor ?? false;
            const shouldOpenInEditor = openInEditor && !settings.enterToOpenFiles;
            const debounceOpen = options?.debounceOpen ?? false;
            const clearIfEmpty = options?.clearIfEmpty ?? false;
            const selectFallback = options?.selectFallback ?? true;
            const selectedFile = selectionState.selectedFile;
            const hasNoSelection = !selectedFile;
            const selectedFileInList = selectedFile ? filePathToIndex.has(selectedFile.path) : false;
            const needsSelection = hasNoSelection || !selectedFileInList;

            if (needsSelection) {
                if (selectFallback && orderedFiles.length > 0) {
                    const firstFile = orderedFiles[0];
                    selectFileFromList(firstFile, {
                        suppressOpen: !shouldOpenInEditor,
                        debounceOpen: shouldOpenInEditor && debounceOpen
                    });
                    return { selectionStateChanged: true };
                }

                if (!selectFallback && clearIfEmpty && orderedFiles.length === 0) {
                    selectionDispatch({ type: 'SET_SELECTED_FILE', file: null });
                    return { selectionStateChanged: true };
                }

                return { selectionStateChanged: false };
            }

            if (shouldOpenInEditor && selectedFile && selectedFileInList) {
                if (debounceOpen) {
                    scheduleKeyboardOpen(selectedFile);
                    return { selectionStateChanged: false };
                }

                openFileInWorkspace(selectedFile);
            }

            return { selectionStateChanged: false };
        },
        [
            filePathToIndex,
            openFileInWorkspace,
            orderedFiles,
            scheduleKeyboardOpen,
            selectFileFromList,
            selectionDispatch,
            selectionState.selectedFile,
            settings.enterToOpenFiles
        ]
    );

    const selectAdjacentFile = useCallback(
        (direction: 'next' | 'previous') => {
            const currentFile = resolvePrimarySelectedFile(app, selectionState);
            const targetFile = getAdjacentFile(orderedFiles, currentFile, direction);
            if (!targetFile) {
                return false;
            }

            selectFileFromList(targetFile, {
                markKeyboardNavigation: true,
                markUserSelection: true,
                suppressOpen: settings.enterToOpenFiles
            });

            const virtualIndex = filePathToIndex.get(targetFile.path);
            if (virtualIndex !== undefined) {
                scrollToIndexSafely(virtualIndex, 'auto');
            }

            return true;
        },
        [app, filePathToIndex, orderedFiles, scrollToIndexSafely, selectFileFromList, selectionState, settings.enterToOpenFiles]
    );

    const handleFileClick = useCallback(
        (file: TFile, event: ReactMouseEvent, fileIndex?: number, filesOverride?: TFile[]) => {
            if (event.button === 1) {
                return;
            }

            isUserSelectionRef.current = true;

            const clickOrderedFiles = filesOverride ?? orderedFiles;
            const isShiftKey = event.shiftKey;
            const isCmdCtrlClick = isCmdCtrlModifierPressed(event);
            const shouldMultiSelect = !isMobile && isMultiSelectModifierPressed(event, settings.multiSelectModifier);
            const shouldOpenInNewTab = !isMobile && !shouldMultiSelect && settings.multiSelectModifier === 'optionAlt' && isCmdCtrlClick;

            if (shouldMultiSelect) {
                handleMultiSelectClick(file, fileIndex, clickOrderedFiles);
            } else if (!isMobile && isShiftKey && fileIndex !== undefined) {
                handleRangeSelectClick(file, fileIndex, clickOrderedFiles);
            } else {
                selectFileFromList(file, {
                    markUserSelection: true,
                    allowSequentialReadingReveal: true,
                    suppressOpen: shouldOpenInNewTab
                });
            }

            uiDispatch({ type: 'SET_FOCUSED_PANE', pane: 'files' });

            if (!shouldMultiSelect && !isShiftKey && shouldOpenInNewTab) {
                runAsyncAction(() => openFileInContext({ app, commandQueue, file, context: 'tab' }));
            }

            if (isMobile && app.workspace.leftSplit && !shouldMultiSelect && !isShiftKey) {
                app.workspace.leftSplit.collapse();
            }
        },
        [
            app,
            commandQueue,
            handleMultiSelectClick,
            handleRangeSelectClick,
            isMobile,
            orderedFiles,
            selectFileFromList,
            settings.multiSelectModifier,
            uiDispatch
        ]
    );

    const handleFileItemClick = useCallback(
        (file: TFile, fileIndex: number | undefined, event: ReactMouseEvent, filesOverride?: TFile[]) => {
            handleFileClick(file, event, fileIndex, filesOverride);
        },
        [handleFileClick]
    );

    const handleFileItemPointerDown = useCallback(
        (file: TFile, event: ReactPointerEvent) => {
            if (event.defaultPrevented || event.button !== 0 || event.pointerType !== 'mouse') {
                return;
            }

            const isShiftKey = event.shiftKey;
            const isCmdCtrlClick = isCmdCtrlModifierPressed(event);
            const shouldMultiSelect = !isMobile && isMultiSelectModifierPressed(event, settings.multiSelectModifier);
            const shouldOpenInNewTab = !isMobile && !shouldMultiSelect && settings.multiSelectModifier === 'optionAlt' && isCmdCtrlClick;
            if (isShiftKey || shouldMultiSelect || shouldOpenInNewTab) {
                return;
            }

            const selectedFiles = selectedFilesRef.current;
            if (selectedFiles.size > 1 && selectedFiles.has(file.path)) {
                return;
            }

            selectFileFromList(file, {
                markUserSelection: true,
                suppressOpen: true
            });
            uiDispatch({ type: 'SET_FOCUSED_PANE', pane: 'files' });
        },
        [isMobile, selectFileFromList, settings.multiSelectModifier, uiDispatch]
    );

    const handleListBackgroundPointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            if (event.defaultPrevented || event.button !== 0 || event.altKey || event.shiftKey || isCmdCtrlModifierPressed(event)) {
                return;
            }

            if (selectionState.selectedFiles.size <= 1) {
                return;
            }

            const target = getPointerTargetElement(event.target);
            if (!target || target.closest(LIST_BACKGROUND_INTERACTIVE_SELECTOR)) {
                return;
            }

            const bounds = event.currentTarget.getBoundingClientRect();
            const isScrollbarHit =
                event.clientX >= bounds.left + event.currentTarget.clientWidth ||
                event.clientY >= bounds.top + event.currentTarget.clientHeight;
            if (isScrollbarHit) {
                return;
            }

            clearPendingKeyboardOpen();
            selectionDispatch({ type: 'CLEAR_FILE_SELECTION' });
            uiDispatch({ type: 'SET_FOCUSED_PANE', pane: 'files' });
        },
        [clearPendingKeyboardOpen, selectionDispatch, selectionState.selectedFiles.size, uiDispatch]
    );

    useEffect(() => {
        if (selectionState.selectedFiles.size <= 1) {
            return;
        }

        const ownerDocument = rootContainerRef.current?.ownerDocument ?? activeDocument;
        const handleDocumentPointerDown = (event: PointerEvent) => {
            if (event.defaultPrevented || event.button !== 0 || event.altKey || event.shiftKey || event.metaKey || event.ctrlKey) {
                return;
            }

            const rootContainer = rootContainerRef.current;
            const target = getPointerTargetElement(event.target);
            if (!rootContainer || !target || rootContainer.contains(target)) {
                return;
            }

            clearPendingKeyboardOpen();
            selectionDispatch({ type: 'CLEAR_FILE_SELECTION' });
        };

        ownerDocument.addEventListener('pointerdown', handleDocumentPointerDown, true);
        return () => {
            ownerDocument.removeEventListener('pointerdown', handleDocumentPointerDown, true);
        };
    }, [clearPendingKeyboardOpen, rootContainerRef, selectionDispatch, selectionState.selectedFiles.size]);

    useEffect(() => {
        if (selectionState.selectedFile) {
            lastSelectedFilePathRef.current = selectionState.selectedFile.path;
        }
    }, [selectionState.selectedFile]);

    useEffect(() => {
        const { selectedFile } = selectionState;
        const isRevealOperation = selectionState.isRevealOperation;
        const isFolderChangeWithAutoSelect = selectionState.isFolderChangeWithAutoSelect;
        const isKeyboardNavigation = selectionState.isKeyboardNavigation;

        if (isRevealOperation || isKeyboardNavigation) {
            if (isKeyboardNavigation) {
                selectionDispatch({ type: 'SET_KEYBOARD_NAVIGATION', isKeyboardNavigation: false });
            }
            return;
        }

        const shouldDebounceFolderAutoOpen = isFolderChangeWithAutoSelect && navigationPhysicalKeyOpenRef.current;
        let selectionStateChangedBySearchSync = false;
        let handledSearchFolderAutoSelect = false;

        if (isSearchActive && settings.autoSelectFirstFileOnFocusChange && !isMobile && isFolderChangeWithAutoSelect) {
            const ensureResult = ensureSelectionForCurrentFilter({
                openInEditor: true,
                clearIfEmpty: true,
                debounceOpen: shouldDebounceFolderAutoOpen
            });
            selectionStateChangedBySearchSync = ensureResult.selectionStateChanged;
            handledSearchFolderAutoSelect = true;
        }

        if (
            !handledSearchFolderAutoSelect &&
            !selectionStateChangedBySearchSync &&
            selectedFile &&
            !isUserSelectionRef.current &&
            settings.autoSelectFirstFileOnFocusChange &&
            !isMobile &&
            isFolderChangeWithAutoSelect &&
            !settings.enterToOpenFiles
        ) {
            if (shouldDebounceFolderAutoOpen) {
                scheduleKeyboardOpen(selectedFile);
            } else {
                openFileInWorkspace(selectedFile);
            }
        }

        if (isFolderChangeWithAutoSelect) {
            if (!selectionStateChangedBySearchSync) {
                selectionDispatch({ type: 'SET_FOLDER_CHANGE_WITH_AUTO_SELECT', isFolderChangeWithAutoSelect: false });
            }
            navigationPhysicalKeyOpenRef.current = false;
        }

        isUserSelectionRef.current = false;
    }, [
        ensureSelectionForCurrentFilter,
        isMobile,
        isSearchActive,
        openFileInWorkspace,
        scheduleKeyboardOpen,
        selectionDispatch,
        selectionState,
        settings.autoSelectFirstFileOnFocusChange,
        settings.enterToOpenFiles
    ]);

    useEffect(() => {
        if (uiState.singlePane || isMobile) {
            return;
        }

        if (uiState.focusedPane === 'files' && selectionState.isKeyboardNavigation) {
            selectionDispatch({ type: 'SET_KEYBOARD_NAVIGATION', isKeyboardNavigation: false });

            const selectedFile = selectionState.selectedFile;
            const hasNoSelection = !selectedFile;
            const selectedFileNotInFilteredList = selectedFile ? !orderedFiles.some(file => file.path === selectedFile.path) : false;
            const needsSelection = hasNoSelection || selectedFileNotInFilteredList;

            if (needsSelection && orderedFiles.length > 0) {
                const activeFile = app.workspace.getActiveFile();
                const activeFileInFilteredList = activeFile ? orderedFiles.some(file => file.path === activeFile.path) : false;

                if (activeFile && activeFileInFilteredList) {
                    selectionDispatch({ type: 'SET_SELECTED_FILE', file: activeFile });
                } else {
                    ensureSelectionForCurrentFilter({ openInEditor: true });
                }
            }
        }
    }, [
        app.workspace,
        ensureSelectionForCurrentFilter,
        isMobile,
        orderedFiles,
        selectionDispatch,
        selectionState.isKeyboardNavigation,
        selectionState.selectedFile,
        uiState.focusedPane,
        uiState.singlePane
    ]);

    return {
        selectFileFromList,
        selectAdjacentFile,
        ensureSelectionForCurrentFilter,
        handleFileItemClick,
        handleFileItemPointerDown,
        handleListBackgroundPointerDown,
        lastSelectedFilePath: lastSelectedFilePathRef.current,
        isFileSelected,
        scheduleKeyboardSelectionOpen,
        scheduleKeyboardSelectionOpenForFile,
        commitPendingKeyboardSelectionOpen
    };
}

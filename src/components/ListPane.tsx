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

/**
 * OPTIMIZATIONS:
 *
 * 1. React.memo with forwardRef - Only re-renders on prop changes
 *
 * 2. Virtualization:
 *    - TanStack Virtual for rendering only visible items
 *    - Estimated row heights from fixed measurements and visible row sections
 *    - Direct memory cache lookups in estimateSize function
 *    - Virtualizer refreshes size estimates when row-height inputs change
 *
 * 3. List building optimization:
 *    - useMemo rebuilds list items only when dependencies change
 *    - File filtering happens once during list build
 *    - Sort operations optimized with pre-computed values
 *    - Pinned files handled separately for efficiency
 *
 * 4. Event handling:
 *    - Debounced vault event handlers via forceUpdate
 *    - Selective updates based on file location (folder/tag context)
 *    - Database content changes trigger selective size-estimate refreshes
 *
 * 5. Selection handling:
 *    - Stable file index for onClick handlers
 *    - Multi-selection support without re-render
 *    - Keyboard navigation optimized
 */

import React, { useRef, useEffect, useImperativeHandle, forwardRef, useState, useMemo, useLayoutEffect } from 'react';
import { TFile, TFolder, Platform, type App } from 'obsidian';
import { Virtualizer } from '@tanstack/react-virtual';
import { useSelectionState, useSelectionDispatch } from '../context/SelectionContext';
import { useServices } from '../context/ServicesContext';
import { useSettingsState, useActiveProfile, useSettingsDerived } from '../context/SettingsContext';
import { useUIState } from '../context/UIStateContext';
import { useExpansionDispatch, useExpansionState } from '../context/ExpansionContext';
import { useFileCache } from '../context/StorageContext';
import { useShortcuts } from '../context/ShortcutsContext';
import { useListPaneKeyboard } from '../hooks/useListPaneKeyboard';
import { useListPaneData } from '../hooks/useListPaneData';
import { findCollapsedListGroupRevealTarget } from '../hooks/listPaneData/listItems';
import { useListPaneScroll } from '../hooks/useListPaneScroll';
import { useListPaneTitle } from '../hooks/useListPaneTitle';
import { useListPaneAppearance } from '../hooks/useListPaneAppearance';
import { useListPaneSearch, type SearchQueryUpdateOptions } from '../hooks/useListPaneSearch';
import { useListPaneSelectionCoordinator } from '../hooks/useListPaneSelectionCoordinator';
import type { EnsureSelectionOptions, EnsureSelectionResult, SelectFileOptions } from '../hooks/useListPaneSelectionCoordinator';
import { useContextMenu } from '../hooks/useContextMenu';
import { IOS_FLOATING_TOOLBAR_HEIGHT_PX, ItemType, ListPaneItemType, type CSSPropertiesWithVars, type NavigatorContext } from '../types';
import { getEffectiveListSort, getSortField, isManualSortPropertyKey, sortFiles } from '../utils/sortUtils';
import { ListPaneHeader } from './ListPaneHeader';
import { ListToolbar } from './ListToolbar';
import { Calendar } from './calendar';
import { SearchInput } from './SearchInput';
import { ListPaneTitleArea } from './ListPaneTitleArea';
import {
    ListPaneVirtualContent,
    getHoveredFilePathAtPointer,
    type ListPaneDragSortDrop,
    type PointerClientPosition
} from './listPane/ListPaneVirtualContent';
import type { FileItemStorageHelpers } from './FileItem';
import { type SearchShortcut } from '../types/shortcuts';
import { type SearchNavFilterState } from '../types/search';
import { EMPTY_LIST_MENU_TYPE } from '../utils/contextMenu';
import { useUXPreferences } from '../context/UXPreferencesContext';
import { type InclusionOperator } from '../utils/filterSearch';
import type { FolderDecorationModel } from '../utils/folderDecoration';
import { useSurfaceColorVariables } from '../hooks/useSurfaceColorVariables';
import { LIST_PANE_SURFACE_COLOR_MAPPINGS } from '../constants/surfaceColorMappings';
import { getListPaneMeasurements } from '../utils/listPaneMeasurements';
import { createHiddenTagVisibility } from '../utils/tagPrefixMatcher';
import { getPropertyKeySet } from '../utils/vaultProfiles';
import { DateUtils } from '../utils/dateUtils';
import type { NavigateToFolderOptions, RevealPropertyOptions, RevealTagOptions } from '../hooks/useNavigatorReveal';
import type { FileItemPillDecorationModel } from '../utils/fileItemPillDecoration';
import type { FileItemPillOrderModel } from '../utils/fileItemPillOrder';
import { compositeWithBase } from '../utils/colorUtils';
import { runAsyncAction } from '../utils/async';
import { getFilesForNavigationSelection, getPinnedSectionCollapseKey } from '../utils/selectionUtils';
import { partitionPinnedFiles } from '../utils/fileFinder';
import { getParentFolderPath } from '../utils/pathUtils';
import { canAttachNoteTreeSelectionToParent, getTopLevelSelectedNoteTreePaths } from '../utils/noteTreeDrag';
import {
    applyManualSortTargetOrderToPlanningScope,
    areManualSortAssignmentsCached,
    buildManualSortRankPlan,
    getFolderPlanningInsertionIndex,
    getCachedManualSortRank,
    getLocalizedManualSortWriteFailureMessage,
    getManualSortPropertyValue,
    getManualSortSelectedMarkdownPaths,
    insertManualSortMarkdownFilesAtDropTarget,
    moveManualSortSelectionByDirection,
    partitionManualSortFiles,
    writeManualSortAssignments,
    type ManualSortOrderAssignment,
    type ManualSortNewFilePlacementContext
} from '../utils/manualSort';
import { showNotice } from '../utils/noticeUtils';
import { getErrorMessage } from '../utils/errorUtils';
import { strings } from '../i18n';
import { ConfirmModal } from '../modals/ConfirmModal';
import { resolveEffectiveListGroupingForSort } from '../utils/listGrouping';
import { focusElementPreventScroll } from '../utils/domUtils';

/**
 * Renders the list pane displaying files from the selected folder.
 * Handles file sorting, grouping by date or folder, pinned notes, and auto-selection.
 * Integrates with the app context to manage file selection and navigation.
 *
 * @returns A scrollable list of files grouped by date or folder with empty state handling
 */
interface ExecuteSearchShortcutParams {
    searchShortcut: SearchShortcut;
}

export type { SelectFileOptions };

export interface ListPaneHandle {
    getIndexOfPath: (path: string) => number;
    virtualizer: Virtualizer<HTMLDivElement, Element> | null;
    scrollContainerRef: HTMLDivElement | null;
    getOrderedFiles: () => TFile[];
    selectFile: (file: TFile, options?: SelectFileOptions) => void;
    selectAdjacentFile: (direction: 'next' | 'previous') => boolean;
    modifySearchWithTag: (tag: string, operator: InclusionOperator, options?: SearchQueryUpdateOptions) => void;
    modifySearchWithProperty: (key: string, value: string | null, operator: InclusionOperator, options?: SearchQueryUpdateOptions) => void;
    modifySearchWithDateToken: (dateToken: string, options?: SearchQueryUpdateOptions) => void;
    toggleSearch: () => void;
    executeSearchShortcut: (params: ExecuteSearchShortcutParams) => Promise<void>;
    getManualSortNewFileContext: () => ManualSortNewFilePlacementContext | null;
}

interface ListPaneProps {
    /**
     * Reference to the root navigator container (.nn-split-container).
     * This is passed from NotebookNavigatorComponent to ensure keyboard events
     * are captured at the navigator level, not globally. This allows proper
     * keyboard navigation between panes while preventing interference with
     * other Obsidian views.
     */
    rootContainerRef: React.RefObject<HTMLDivElement | null>;
    /**
     * Optional resize handle props for dual-pane mode.
     * When provided, renders a resize handle overlay on the list pane boundary.
     */
    resizeHandleProps?: {
        onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
    };
    /**
     * Callback invoked whenever tag-related search tokens change.
     */
    onSearchTokensChange?: (state: SearchNavFilterState) => void;
    folderDecorationModel: FolderDecorationModel;
    fileItemPillDecorationModel: FileItemPillDecorationModel;
    fileItemPillOrderModel: FileItemPillOrderModel;
    onNavigateToFolder: (folderPath: string, options?: NavigateToFolderOptions) => void;
    onRevealTag: (tagPath: string, options?: RevealTagOptions) => void;
    onRevealProperty: (propertyNodeId: string, options?: RevealPropertyOptions) => boolean;
}

interface PropertyKeyboardReorderState {
    propertyKey: string;
    order: string[];
    pendingAssignments: ManualSortOrderAssignment[];
    assignmentFiles: TFile[];
    isSaving: boolean;
    selectionKey: string;
    saveId: number;
}

interface ManualSortPlanningBase {
    files: TFile[];
    isBroadened: boolean;
}

interface ManualSortPlanningContext {
    files: TFile[];
    isBroadened: boolean;
    rankByPath: Map<string, number>;
    insertionIndex?: number;
}

function getMarkdownPathOrder(files: readonly TFile[]): string[] {
    return partitionManualSortFiles(files).markdown.map(file => file.path);
}

function buildManualSortRankMap(
    app: App,
    files: readonly TFile[],
    propertyKey: string,
    pendingAssignments: readonly ManualSortOrderAssignment[] = []
): Map<string, number> {
    const rankByPath = new Map<string, number>();
    if (!propertyKey) {
        return rankByPath;
    }

    const filePathSet = new Set(files.map(file => file.path));
    files.forEach(file => {
        if (file.extension !== 'md') {
            return;
        }

        const rank = getCachedManualSortRank(app, file, propertyKey);
        if (rank !== null) {
            rankByPath.set(file.path, rank);
        }
    });

    pendingAssignments.forEach(assignment => {
        if (filePathSet.has(assignment.path)) {
            rankByPath.set(assignment.path, assignment.value);
        }
    });

    return rankByPath;
}

interface ListPaneTitleChromeProps {
    onHeaderClick?: () => void;
    isSearchActive?: boolean;
    onSearchToggle?: () => void;
    getManualSortNewFileContext?: () => ManualSortNewFilePlacementContext | null;
    shouldShowDesktopTitleArea: boolean;
    children: React.ReactNode;
}

function ListPaneTitleChrome({
    onHeaderClick,
    isSearchActive,
    onSearchToggle,
    getManualSortNewFileContext,
    shouldShowDesktopTitleArea,
    children
}: ListPaneTitleChromeProps) {
    const { desktopTitle, breadcrumbSegments, iconName, showIcon } = useListPaneTitle();
    return (
        <>
            <ListPaneHeader
                onHeaderClick={onHeaderClick}
                isSearchActive={isSearchActive}
                onSearchToggle={onSearchToggle}
                getManualSortNewFileContext={getManualSortNewFileContext}
                desktopTitle={desktopTitle}
                breadcrumbSegments={breadcrumbSegments}
                iconName={iconName}
                showIcon={showIcon}
            />
            {children}
            {shouldShowDesktopTitleArea ? <ListPaneTitleArea desktopTitle={desktopTitle} /> : null}
        </>
    );
}

export const ListPane = React.memo(
    forwardRef<ListPaneHandle, ListPaneProps>(function ListPane(props, ref) {
        const { app, isMobile, plugin, fileSystemOps, tagTreeService, propertyTreeService, hierarchyService } = useServices();
        const {
            onNavigateToFolder,
            onRevealTag,
            onRevealProperty,
            folderDecorationModel,
            fileItemPillDecorationModel,
            fileItemPillOrderModel
        } = props;
        const selectionState = useSelectionState();
        const selectionDispatch = useSelectionDispatch();
        const settings = useSettingsState();
        const activeProfile = useActiveProfile();
        const { fileNameIconNeedles } = useSettingsDerived();
        const expansionState = useExpansionState();
        const expansionDispatch = useExpansionDispatch();
        const uxPreferences = useUXPreferences();
        const includeDescendantNotes = uxPreferences.includeDescendantNotes;
        const showHiddenItems = uxPreferences.showHiddenItems;
        const showCalendar = uxPreferences.showCalendar;
        const appearanceSettings = useListPaneAppearance();
        const { getFileDisplayName, getDB, getFileTimestamps, hasPreview, regenerateFeatureImageForFile } = useFileCache();
        const { noteShortcutKeysByPath, addNoteShortcut, removeShortcut } = useShortcuts();
        const uiState = useUIState();
        const isVerticalDualPane = !uiState.singlePane && uiState.effectiveDualPaneOrientation === 'vertical';
        const calendarPlacement = settings.calendarPlacement;
        const shouldRenderCalendarOverlay =
            settings.calendarEnabled && calendarPlacement === 'left-sidebar' && showCalendar && isVerticalDualPane;
        const listPaneRef = useRef<HTMLDivElement | null>(null);
        const hoverPointerClientPositionRef = useRef<PointerClientPosition | null>(null);
        // Android uses toolbar at top, iOS at bottom
        const isAndroid = Platform.isAndroidApp;
        /** Maps semi-transparent theme color variables to computed opaque equivalents (see constants/surfaceColorMappings). */
        const { color: listSurfaceColor, version: listSurfaceVersion } = useSurfaceColorVariables(listPaneRef, {
            app,
            rootContainerRef: props.rootContainerRef,
            variables: LIST_PANE_SURFACE_COLOR_MAPPINGS
        });
        const solidBackgroundCacheRef = useRef<Map<string, string | undefined>>(new Map());
        const [calendarWeekCount, setCalendarWeekCount] = useState<number>(() => settings.calendarWeeksToShow);
        const [isListScrolling, setIsListScrolling] = useState(false);
        const [hoveredFilePath, setHoveredFilePath] = useState<string | null>(null);
        const [inlineRenameFilePath, setInlineRenameFilePath] = useState<string | null>(null);
        const [propertyKeyboardReorderState, setPropertyKeyboardReorderState] = useState<PropertyKeyboardReorderState | null>(null);
        const hoverSyncFrameRef = useRef<number | null>(null);
        const pinnedRevealExpansionRef = useRef<string | null>(null);
        const propertyKeyboardReorderSaveCounterRef = useRef(0);
        const propertyKeyboardReorderSavingRef = useRef(false);
        const propertyKeyboardReorderScrollPathRef = useRef<string | null>(null);
        const addNoteShortcutRef = useRef(addNoteShortcut);
        const removeShortcutRef = useRef(removeShortcut);
        const listPaneTitle = settings.listPaneTitle ?? 'header';
        const shouldShowDesktopTitleArea = !isMobile && listPaneTitle === 'list';
        const listMeasurements = getListPaneMeasurements(isMobile);
        const topSpacerHeight = shouldShowDesktopTitleArea ? 0 : listMeasurements.topSpacer;
        const iconColumnStyle = useMemo(() => {
            if (settings.showFileIcons) {
                return undefined;
            }
            return {
                '--nn-file-icon-slot-width': '0px',
                '--nn-file-icon-slot-width-mobile': '0px',
                '--nn-file-icon-slot-gap': '0px'
            } as React.CSSProperties;
        }, [settings.showFileIcons]);
        const listPaneStyle = useMemo<CSSPropertiesWithVars>(() => {
            return {
                ...(iconColumnStyle ?? {}),
                '--nn-calendar-week-count': calendarWeekCount
            };
        }, [calendarWeekCount, iconColumnStyle]);

        useEffect(() => {
            if (settings.calendarWeeksToShow !== 6) {
                setCalendarWeekCount(settings.calendarWeeksToShow);
            }
        }, [settings.calendarWeeksToShow]);

        useEffect(() => {
            solidBackgroundCacheRef.current.clear();
        }, [listSurfaceColor, listSurfaceVersion]);

        const getSolidBackground = useMemo(() => {
            return (color?: string | null) => {
                void listSurfaceVersion;
                if (!color) {
                    return undefined;
                }
                const trimmed = color.trim();
                if (!trimmed) {
                    return undefined;
                }
                const cache = solidBackgroundCacheRef.current;
                if (cache.has(trimmed)) {
                    return cache.get(trimmed);
                }
                const pane = listPaneRef.current;
                const solidColor = compositeWithBase(listSurfaceColor, trimmed, { container: pane ?? null });
                cache.set(trimmed, solidColor);
                return solidColor;
            };
        }, [listSurfaceColor, listSurfaceVersion]);

        const shouldUseFloatingToolbars = isMobile && Platform.isIosApp && settings.useFloatingToolbars;
        const scrollPaddingEnd = useMemo(() => {
            if (!shouldUseFloatingToolbars) {
                return 0;
            }

            // Keep in sync with `--nn-ios-pane-bottom-overlay-height` in `src/styles/sections/platform-ios.css`.
            // The calendar overlay is outside the scroller, so it is intentionally not included here.
            return IOS_FLOATING_TOOLBAR_HEIGHT_PX;
        }, [shouldUseFloatingToolbars]);
        const ensureSelectionForCurrentFilterRef = useRef<((options?: EnsureSelectionOptions) => EnsureSelectionResult) | null>(null);
        const {
            isSearchActive,
            searchProvider,
            searchQuery,
            debouncedSearchQuery,
            debouncedSearchTokens,
            searchHighlightQuery,
            shouldFocusSearch,
            activeSearchShortcut,
            isSavingSearchShortcut,
            suppressSearchTopScrollRef,
            setSearchQuery,
            handleSearchToggle,
            closeSearch,
            focusSearchComplete,
            handleSaveSearchShortcut,
            handleRemoveSearchShortcut,
            modifySearchWithTag,
            modifySearchWithProperty,
            modifySearchWithDateToken,
            toggleSearch,
            executeSearchShortcut
        } = useListPaneSearch({
            rootContainerRef: props.rootContainerRef,
            onSearchTokensChange: props.onSearchTokensChange,
            onNavigateToFolder,
            onRevealTag,
            onRevealProperty,
            ensureSelectionForCurrentFilterRef
        });

        const { selectionType, selectedFolder, selectedTag, selectedProperty, selectedFile } = selectionState;
        const selectedFolderPath = selectionType === ItemType.FOLDER ? (selectedFolder?.path ?? null) : null;
        const effectiveSortSpec = getEffectiveListSort(settings, selectionType, selectedFolder, selectedTag, selectedProperty);
        const effectiveSortOption = effectiveSortSpec.option;
        const effectivePropertySortKey = effectiveSortSpec.propertyKey.trim();
        const isPropertySortActive = getSortField(effectiveSortOption) === 'property';
        const isManualSortActive = isPropertySortActive && isManualSortPropertyKey(settings, effectivePropertySortKey);
        const manualSortSelectionKey = useMemo(() => {
            if (selectionType === ItemType.FOLDER && selectedFolder) {
                return `${selectionType}:${selectedFolder.path}`;
            }
            if (selectionType === ItemType.TAG && selectedTag) {
                return `${selectionType}:${selectedTag}`;
            }
            if (selectionType === ItemType.PROPERTY && selectedProperty) {
                return `${selectionType}:${selectedProperty}`;
            }
            return 'none';
        }, [selectedFolder, selectedProperty, selectedTag, selectionType]);
        const pinnedCollapseKey = getPinnedSectionCollapseKey({ selectionType, selectedFolder, selectedTag, selectedProperty });
        const pinnedGroupExpanded = settings.collapsedPinnedContexts[pinnedCollapseKey] !== true;
        const handlePinnedGroupHeaderToggle = React.useCallback(() => {
            runAsyncAction(() => plugin.togglePinnedGroupCollapsed(pinnedCollapseKey));
        }, [pinnedCollapseKey, plugin]);
        const collapsedListGroups = expansionState.collapsedListGroups;
        const groupCollapseStateSignature = useMemo(() => {
            const collapsedGroupKeys = Array.from(collapsedListGroups);
            collapsedGroupKeys.sort();
            return `${pinnedGroupExpanded ? 'expanded' : 'collapsed'}:${collapsedGroupKeys.join('\u0001')}`;
        }, [collapsedListGroups, pinnedGroupExpanded]);
        const handleListGroupHeaderToggle = React.useCallback(
            (collapseKey: string) => {
                expansionDispatch({ type: 'TOGGLE_LIST_GROUP_COLLAPSED', collapseKey });
            },
            [expansionDispatch]
        );
        const handleNoteTreeToggle = React.useCallback(
            (nodeKey: string) => {
                expansionDispatch({ type: 'TOGGLE_NOTE_TREE_NODE_EXPANDED', nodeKey });
            },
            [expansionDispatch]
        );

        useEffect(() => {
            if (!propertyKeyboardReorderState) {
                return;
            }

            if (
                isSearchActive ||
                !isManualSortActive ||
                !effectivePropertySortKey ||
                propertyKeyboardReorderState.selectionKey !== manualSortSelectionKey ||
                propertyKeyboardReorderState.propertyKey !== effectivePropertySortKey
            ) {
                propertyKeyboardReorderSavingRef.current = false;
                propertyKeyboardReorderScrollPathRef.current = null;
                setPropertyKeyboardReorderState(null);
            }
        }, [effectivePropertySortKey, isManualSortActive, isSearchActive, manualSortSelectionKey, propertyKeyboardReorderState]);

        const canUsePropertyKeyboardReorder = !isSearchActive && isManualSortActive && effectivePropertySortKey.length > 0;
        const activePropertyKeyboardReorderState =
            canUsePropertyKeyboardReorder &&
            propertyKeyboardReorderState?.selectionKey === manualSortSelectionKey &&
            propertyKeyboardReorderState.propertyKey === effectivePropertySortKey
                ? propertyKeyboardReorderState
                : null;
        const propertySortOrderOverride = activePropertyKeyboardReorderState?.order ?? null;

        const effectiveGroupBy = resolveEffectiveListGroupingForSort({
            groupBy: appearanceSettings.groupBy,
            sortOption: effectiveSortOption,
            selectionType,
            isManualSortActive,
            isManualSortEditActive: false
        });
        const effectiveAppearanceSettings = useMemo(
            () =>
                effectiveGroupBy === appearanceSettings.groupBy ? appearanceSettings : { ...appearanceSettings, groupBy: effectiveGroupBy },
            [appearanceSettings, effectiveGroupBy]
        );

        const saveManualSortAssignments = React.useCallback(
            (
                filesToWrite: TFile[],
                propertyKey: string,
                assignments: readonly ManualSortOrderAssignment[],
                onComplete: (hasFailure: boolean) => void
            ) => {
                if (assignments.length === 0) {
                    onComplete(false);
                    return;
                }

                runAsyncAction(async () => {
                    let hasFailure = false;
                    try {
                        const result = await writeManualSortAssignments(app, filesToWrite, propertyKey, assignments);
                        if (result.failed > 0) {
                            hasFailure = true;
                            showNotice(
                                strings.dragDrop.errors.failedToSetProperty.replace(
                                    '{error}',
                                    getLocalizedManualSortWriteFailureMessage(result)
                                ),
                                { variant: 'warning' }
                            );
                        }
                    } catch (error) {
                        hasFailure = true;
                        showNotice(
                            strings.dragDrop.errors.failedToSetProperty.replace(
                                '{error}',
                                getErrorMessage(error, strings.common.unknownError)
                            ),
                            { variant: 'warning' }
                        );
                    } finally {
                        onComplete(hasFailure);
                    }
                });
            },
            [app]
        );

        const savePropertyKeyboardReorder = React.useCallback(
            (
                filesToWrite: TFile[],
                propertyKey: string,
                assignments: readonly ManualSortOrderAssignment[],
                selectionKey: string,
                saveId: number
            ) => {
                saveManualSortAssignments(filesToWrite, propertyKey, assignments, shouldClearOptimisticOrder => {
                    if (propertyKeyboardReorderSaveCounterRef.current === saveId) {
                        propertyKeyboardReorderSavingRef.current = false;
                    }
                    setPropertyKeyboardReorderState(current => {
                        if (
                            !current ||
                            current.propertyKey !== propertyKey ||
                            current.selectionKey !== selectionKey ||
                            current.saveId !== saveId
                        ) {
                            return current;
                        }
                        return shouldClearOptimisticOrder ? null : { ...current, isSaving: false };
                    });
                });
            },
            [saveManualSortAssignments]
        );

        const confirmManualSortCompaction = React.useCallback(
            (assignmentCount: number, onConfirm: () => void) => {
                new ConfirmModal(
                    app,
                    strings.modals.manualSortConfirm.compactTitle,
                    strings.modals.manualSortConfirm.compactMessage(assignmentCount),
                    onConfirm,
                    strings.modals.manualSortConfirm.compactConfirmButton,
                    { confirmButtonClass: 'mod-cta' }
                ).open();
            },
            [app]
        );

        // Determine if list pane is visible early to optimize
        const isVisible = !uiState.singlePane || uiState.currentSinglePaneView === 'files';

        // Use the new data hook
        const { listItems, orderedFiles, orderedFileIndexMap, filePathToIndex, files, localDayKey } = useListPaneData({
            selectionType,
            selectedFolder,
            selectedTag,
            selectedProperty,
            settings,
            activeProfile,
            groupBy: effectiveAppearanceSettings.groupBy,
            pinnedGroupExpanded,
            collapsedListGroups,
            expandedNoteTreeNodes: expansionState.expandedNoteTreeNodes,
            searchProvider,
            // Use debounced value for filtering
            searchQuery: isSearchActive ? debouncedSearchQuery : undefined,
            searchTokens: isSearchActive ? debouncedSearchTokens : undefined,
            visibility: { includeDescendantNotes, showHiddenItems },
            propertySortOrderOverride
        });
        const listStartsWithGroupHeader =
            listItems[0]?.type === ListPaneItemType.TOP_SPACER && listItems[1]?.type === ListPaneItemType.HEADER;
        const effectiveTopSpacerHeight = settings.stickyGroupHeaders && listStartsWithGroupHeader ? 0 : topSpacerHeight;
        const localDayReference = useMemo(() => DateUtils.parseLocalDayKey(localDayKey), [localDayKey]);

        useEffect(() => {
            if (!propertyKeyboardReorderState || propertyKeyboardReorderState.isSaving) {
                return;
            }

            const writtenPathSet = new Set(propertyKeyboardReorderState.order);
            const writtenFiles = files.filter(file => writtenPathSet.has(file.path));
            const markdownOrder = writtenFiles.filter(file => file.extension === 'md').map(file => file.path);
            const isSameWrittenOrder =
                markdownOrder.length === propertyKeyboardReorderState.order.length &&
                markdownOrder.every((path, index) => path === propertyKeyboardReorderState.order[index]);

            if (!isSameWrittenOrder) {
                setPropertyKeyboardReorderState(current =>
                    current && current.saveId === propertyKeyboardReorderState.saveId ? null : current
                );
                return;
            }

            if (
                !areManualSortAssignmentsCached(
                    app,
                    propertyKeyboardReorderState.assignmentFiles,
                    propertyKeyboardReorderState.propertyKey,
                    propertyKeyboardReorderState.pendingAssignments
                )
            ) {
                return;
            }

            setPropertyKeyboardReorderState(current =>
                current && current.saveId === propertyKeyboardReorderState.saveId && !current.isSaving ? null : current
            );
        }, [app, files, propertyKeyboardReorderState]);

        // Determine the target folder path for drag-and-drop of external files
        const activeFolderDropPath = useMemo(() => {
            if (selectionType !== 'folder' || !selectedFolder) {
                return null;
            }
            return selectedFolder.path;
        }, [selectionType, selectedFolder]);
        const { visibleListPropertyKeys, visibleNavigationPropertyKeys } = useMemo(() => {
            return {
                visibleListPropertyKeys: getPropertyKeySet(activeProfile.propertyKeys, 'list'),
                visibleNavigationPropertyKeys: getPropertyKeySet(activeProfile.propertyKeys, 'navigation')
            };
        }, [activeProfile.propertyKeys]);
        const fileItemStorage = useMemo<FileItemStorageHelpers>(
            () => ({
                getFileDisplayName,
                getDB,
                getFileTimestamps,
                hasPreview,
                regenerateFeatureImageForFile
            }),
            [getFileDisplayName, getDB, getFileTimestamps, hasPreview, regenerateFeatureImageForFile]
        );
        const hiddenTagVisibility = useMemo(
            () => createHiddenTagVisibility(activeProfile.hiddenTags, showHiddenItems),
            [activeProfile.hiddenTags, showHiddenItems]
        );
        const syncHoveredFilePathToPointer = React.useCallback((scrollElement: HTMLDivElement | null) => {
            const nextHoveredFilePath = getHoveredFilePathAtPointer(scrollElement, hoverPointerClientPositionRef.current);
            setHoveredFilePath(previous => (previous === nextHoveredFilePath ? previous : nextHoveredFilePath));
        }, []);
        const syncHoveredFilePathToPointerAfterPaint = React.useCallback(
            (scrollElement: HTMLDivElement | null) => {
                if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
                    syncHoveredFilePathToPointer(scrollElement);
                    return;
                }

                if (hoverSyncFrameRef.current !== null) {
                    window.cancelAnimationFrame(hoverSyncFrameRef.current);
                }

                hoverSyncFrameRef.current = window.requestAnimationFrame(() => {
                    hoverSyncFrameRef.current = null;
                    syncHoveredFilePathToPointer(scrollElement);
                });
            },
            [syncHoveredFilePathToPointer]
        );
        const handleVirtualizerScrollingChange = React.useCallback(
            (isScrolling: boolean, scrollElement: HTMLDivElement | null) => {
                if (isScrolling) {
                    setIsListScrolling(previous => (previous ? previous : true));
                    setHoveredFilePath(previous => (previous === null ? previous : null));
                    return;
                }

                syncHoveredFilePathToPointer(scrollElement);
                setIsListScrolling(false);
            },
            [syncHoveredFilePathToPointer]
        );
        const handleScrollContainerVisibilityChange = React.useCallback(
            (isContainerVisible: boolean, scrollElement: HTMLDivElement | null) => {
                setIsListScrolling(false);

                if (!isContainerVisible) {
                    if (hoverSyncFrameRef.current !== null) {
                        window.cancelAnimationFrame(hoverSyncFrameRef.current);
                        hoverSyncFrameRef.current = null;
                    }
                    setHoveredFilePath(previous => (previous === null ? previous : null));
                    return;
                }

                syncHoveredFilePathToPointer(scrollElement);
                syncHoveredFilePathToPointerAfterPaint(scrollElement);
            },
            [syncHoveredFilePathToPointer, syncHoveredFilePathToPointerAfterPaint]
        );
        const visibleListPropertyKeySignature = useMemo(() => {
            if (visibleListPropertyKeys.size === 0) {
                return '';
            }

            const sortedKeys = Array.from(visibleListPropertyKeys);
            sortedKeys.sort();
            return sortedKeys.join('\u0001');
        }, [visibleListPropertyKeys]);

        useEffect(() => {
            if (
                !selectionState.isRevealOperation ||
                selectionState.revealSource !== 'manual' ||
                !selectedFile ||
                filePathToIndex.has(selectedFile.path)
            ) {
                return;
            }

            const revealTarget = findCollapsedListGroupRevealTarget(listItems, selectedFile.path, pinnedGroupExpanded);
            if (!revealTarget) {
                return;
            }

            if (revealTarget.type === 'pinned') {
                if (pinnedRevealExpansionRef.current === pinnedCollapseKey) {
                    return;
                }

                pinnedRevealExpansionRef.current = pinnedCollapseKey;
                runAsyncAction(async () => {
                    try {
                        await plugin.togglePinnedGroupCollapsed(pinnedCollapseKey);
                    } finally {
                        if (pinnedRevealExpansionRef.current === pinnedCollapseKey) {
                            pinnedRevealExpansionRef.current = null;
                        }
                    }
                });
                return;
            }

            expansionDispatch({ type: 'EXPAND_LIST_GROUP', collapseKey: revealTarget.collapseKey });
        }, [
            expansionDispatch,
            filePathToIndex,
            listItems,
            pinnedCollapseKey,
            pinnedGroupExpanded,
            plugin,
            selectedFile,
            selectionState.isRevealOperation,
            selectionState.revealSource
        ]);

        // Use the new scroll hook
        const { rowVirtualizer, scrollContainerRef, scrollContainerRefCallback, handleScrollToTop, scrollToIndexSafely } =
            useListPaneScroll({
                enabled: true,
                listItems,
                filePathToIndex,
                selectedFile,
                selectedFolder,
                selectedTag,
                selectedProperty,
                settings,
                folderSettings: effectiveAppearanceSettings,
                isVisible,
                selectionState,
                selectionDispatch,
                // Use debounced value for scroll orchestration to align with filtering
                searchQuery: isSearchActive ? debouncedSearchQuery : undefined,
                suppressSearchTopScrollRef,
                topSpacerHeight: effectiveTopSpacerHeight,
                includeDescendantNotes,
                groupCollapseStateSignature,
                visiblePropertyKeys: visibleListPropertyKeys,
                visiblePropertyKeySignature: visibleListPropertyKeySignature,
                hiddenTagVisibility,
                scrollMargin: 0,
                scrollPaddingEnd,
                onVirtualizerScrollingChange: handleVirtualizerScrollingChange,
                onScrollContainerVisibilityChange: handleScrollContainerVisibilityChange
            });

        const restoreListPaneFocus = React.useCallback(() => {
            const restore = () => {
                const target = scrollContainerRef.current ?? props.rootContainerRef.current;
                if (target) {
                    focusElementPreventScroll(target);
                }
            };

            if (typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(restore);
                return;
            }

            window.setTimeout(restore, 0);
        }, [props.rootContainerRef, scrollContainerRef]);

        const prevCalendarOverlayVisibleRef = useRef<boolean>(shouldRenderCalendarOverlay);
        const prevCalendarWeekCountRef = useRef<number>(calendarWeekCount);

        useEffect(() => {
            const wasVisible = prevCalendarOverlayVisibleRef.current;
            const prevWeekCount = prevCalendarWeekCountRef.current;

            const becameVisible = shouldRenderCalendarOverlay && !wasVisible;
            const weekCountChanged = shouldRenderCalendarOverlay && calendarWeekCount !== prevWeekCount;

            prevCalendarOverlayVisibleRef.current = shouldRenderCalendarOverlay;
            prevCalendarWeekCountRef.current = calendarWeekCount;

            if (!becameVisible && !weekCountChanged) {
                return;
            }

            if (!selectedFile) {
                return;
            }

            const index = filePathToIndex.get(selectedFile.path);
            if (index === undefined) {
                return;
            }

            const scheduleScroll = () => scrollToIndexSafely(index, 'auto');

            if (typeof requestAnimationFrame !== 'undefined') {
                window.requestAnimationFrame(() => {
                    window.requestAnimationFrame(scheduleScroll);
                });
                return;
            }

            window.setTimeout(scheduleScroll, 0);
        }, [calendarWeekCount, filePathToIndex, scrollToIndexSafely, selectedFile, shouldRenderCalendarOverlay]);

        const handleHoveredFilePathChange = React.useCallback(
            (path: string | null, pointerClientPosition: PointerClientPosition | null) => {
                hoverPointerClientPositionRef.current = pointerClientPosition;
                setHoveredFilePath(previous => (previous === path ? previous : path));
            },
            []
        );

        useEffect(() => {
            if (isMobile) {
                return;
            }

            const handleWindowMouseMove = (event: MouseEvent) => {
                hoverPointerClientPositionRef.current = {
                    clientX: event.clientX,
                    clientY: event.clientY
                };
            };
            const handleWindowMouseOut = (event: MouseEvent) => {
                if (!event.relatedTarget) {
                    hoverPointerClientPositionRef.current = null;
                }
            };

            window.addEventListener('mousemove', handleWindowMouseMove, { passive: true });
            window.addEventListener('mouseout', handleWindowMouseOut);
            return () => {
                window.removeEventListener('mousemove', handleWindowMouseMove);
                window.removeEventListener('mouseout', handleWindowMouseOut);
            };
        }, [isMobile]);

        useEffect(() => {
            return () => {
                if (hoverSyncFrameRef.current !== null) {
                    window.cancelAnimationFrame(hoverSyncFrameRef.current);
                    hoverSyncFrameRef.current = null;
                }
            };
        }, []);

        useLayoutEffect(() => {
            if (isListScrolling) {
                return;
            }

            syncHoveredFilePathToPointer(scrollContainerRef.current);
        }, [isListScrolling, listItems, scrollContainerRef, syncHoveredFilePathToPointer]);

        useEffect(() => {
            addNoteShortcutRef.current = addNoteShortcut;
            removeShortcutRef.current = removeShortcut;
        }, [addNoteShortcut, removeShortcut]);

        // Attach context menu to empty areas in the list pane for file creation
        useContextMenu(scrollContainerRef, { type: EMPTY_LIST_MENU_TYPE, item: selectedFolder ?? null, options: { orderedFiles } });

        const isCompactMode = appearanceSettings.mode === 'compact';
        const {
            selectFileFromList,
            selectAdjacentFile,
            ensureSelectionForCurrentFilter,
            handleFileItemClick,
            handleFileItemPointerDown,
            handleListBackgroundPointerDown,
            lastSelectedFilePath,
            isFileSelected,
            scheduleKeyboardSelectionOpen,
            scheduleKeyboardSelectionOpenForFile,
            commitPendingKeyboardSelectionOpen
        } = useListPaneSelectionCoordinator({
            rootContainerRef: props.rootContainerRef,
            orderedFiles,
            filePathToIndex,
            scrollToIndexSafely
        });
        ensureSelectionForCurrentFilterRef.current = ensureSelectionForCurrentFilter;
        const toggleNoteShortcut = React.useCallback(async (file: TFile, shortcutKey: string | undefined) => {
            if (shortcutKey) {
                await removeShortcutRef.current(shortcutKey);
                return;
            }

            await addNoteShortcutRef.current(file.path);
        }, []);

        const sortManualSortFilesForProperty = React.useCallback(
            (sourceFiles: readonly TFile[], propertyKey: string, rankByPath: ReadonlyMap<string, number>): TFile[] => {
                if (!propertyKey) {
                    return [...sourceFiles];
                }

                const sortedFiles = [...sourceFiles];
                const propertyValueByPath = new Map<string, string | null>();
                const getCachedManualSortPropertyValue = (file: TFile): string | null => {
                    if (propertyValueByPath.has(file.path)) {
                        return propertyValueByPath.get(file.path) ?? null;
                    }

                    const pendingRank = rankByPath.get(file.path);
                    const value = pendingRank === undefined ? getManualSortPropertyValue(app, file, propertyKey) : pendingRank.toString();
                    propertyValueByPath.set(file.path, value);
                    return value;
                };

                sortFiles(
                    sortedFiles,
                    'property-asc',
                    file => getFileTimestamps(file).created,
                    file => getFileTimestamps(file).modified,
                    getFileDisplayName,
                    getCachedManualSortPropertyValue,
                    settings.propertySortSecondary
                );
                return sortedFiles;
            },
            [app, getFileDisplayName, getFileTimestamps, settings.propertySortSecondary]
        );

        const getManualSortPlanningBase = React.useCallback(
            (propertyKey: string): ManualSortPlanningBase => {
                if (!propertyKey || selectionType !== ItemType.FOLDER || !selectedFolder || !includeDescendantNotes) {
                    return { files, isBroadened: false };
                }

                let planningFolder = selectedFolder.parent instanceof TFolder ? selectedFolder.parent : null;
                if (!planningFolder || planningFolder.path === selectedFolder.path) {
                    return { files, isBroadened: false };
                }

                while (planningFolder.parent instanceof TFolder && planningFolder.parent.path !== planningFolder.path) {
                    planningFolder = planningFolder.parent;
                }

                const planningFiles = getFilesForNavigationSelection(
                    {
                        selectionType: ItemType.FOLDER,
                        selectedFolder: planningFolder
                    },
                    settings,
                    { includeDescendantNotes: true, showHiddenItems },
                    app,
                    tagTreeService,
                    propertyTreeService,
                    { orderResults: false }
                );
                const selectedPathSet = new Set(files.map(file => file.path));
                const hasBroaderFiles = planningFiles.some(file => !selectedPathSet.has(file.path));

                return hasBroaderFiles ? { files: planningFiles, isBroadened: true } : { files, isBroadened: false };
            },
            [
                app,
                files,
                includeDescendantNotes,
                propertyTreeService,
                selectedFolder,
                selectionType,
                settings,
                showHiddenItems,
                tagTreeService
            ]
        );

        const propertyKeyboardRankByPath = useMemo(() => {
            if (!canUsePropertyKeyboardReorder) {
                return new Map<string, number>();
            }

            return buildManualSortRankMap(
                app,
                orderedFiles,
                effectivePropertySortKey,
                activePropertyKeyboardReorderState?.pendingAssignments ?? []
            );
        }, [
            activePropertyKeyboardReorderState?.pendingAssignments,
            app,
            canUsePropertyKeyboardReorder,
            effectivePropertySortKey,
            orderedFiles
        ]);
        const getPropertyKeyboardPlanningContext = React.useCallback((): ManualSortPlanningContext => {
            if (!canUsePropertyKeyboardReorder) {
                return { files: orderedFiles, isBroadened: false, rankByPath: propertyKeyboardRankByPath };
            }

            const planningBase = getManualSortPlanningBase(effectivePropertySortKey);
            if (!planningBase.isBroadened) {
                return { files: orderedFiles, isBroadened: false, rankByPath: propertyKeyboardRankByPath };
            }

            const rankByPath = buildManualSortRankMap(
                app,
                planningBase.files,
                effectivePropertySortKey,
                activePropertyKeyboardReorderState?.pendingAssignments ?? []
            );
            const planningFiles = sortManualSortFilesForProperty(planningBase.files, effectivePropertySortKey, rankByPath);
            return {
                files: planningFiles,
                isBroadened: true,
                rankByPath,
                insertionIndex: getFolderPlanningInsertionIndex(selectedFolder, planningBase.files, planningFiles)
            };
        }, [
            activePropertyKeyboardReorderState?.pendingAssignments,
            app,
            canUsePropertyKeyboardReorder,
            effectivePropertySortKey,
            getManualSortPlanningBase,
            orderedFiles,
            propertyKeyboardRankByPath,
            selectedFolder,
            sortManualSortFilesForProperty
        ]);
        const getPropertyKeyboardReorderScopeFiles = React.useCallback(
            (activePath: string | null): TFile[] => {
                if (!activePath) {
                    return [];
                }

                const activeItem = listItems.find(
                    item => item.type === ListPaneItemType.FILE && item.data instanceof TFile && item.data.path === activePath
                );
                if (!activeItem || !(activeItem.data instanceof TFile)) {
                    return [];
                }

                const activePinnedState = Boolean(activeItem.isPinned);
                return listItems.flatMap(item => {
                    if (item.type !== ListPaneItemType.FILE || !(item.data instanceof TFile)) {
                        return [];
                    }
                    if (Boolean(item.isPinned) !== activePinnedState) {
                        return [];
                    }
                    return [item.data];
                });
            },
            [listItems]
        );
        const handlePropertyKeyboardReorder = React.useCallback(
            (direction: 'up' | 'down') => {
                if (!canUsePropertyKeyboardReorder) {
                    return false;
                }

                if (propertyKeyboardReorderSavingRef.current) {
                    return true;
                }

                const activePath = selectedFile?.path ?? null;
                const reorderScopeFiles = getPropertyKeyboardReorderScopeFiles(activePath);
                const result = moveManualSortSelectionByDirection(reorderScopeFiles, activePath, selectionState.selectedFiles, direction);
                if (!result) {
                    return true;
                }

                const reorderScopePaths = new Set(reorderScopeFiles.map(file => file.path));
                let resultFileIndex = 0;
                const nextOrderedFiles = orderedFiles.map(file => {
                    if (!reorderScopePaths.has(file.path)) {
                        return file;
                    }

                    const resultFile = result.files[resultFileIndex];
                    resultFileIndex += 1;
                    return resultFile ?? file;
                });
                const { markdown } = partitionManualSortFiles(reorderScopeFiles);
                const selectedMarkdownPaths = getManualSortSelectedMarkdownPaths(markdown, activePath ?? '', selectionState.selectedFiles);
                const movedPaths = selectedMarkdownPaths.size > 1 ? selectedMarkdownPaths : new Set(activePath ? [activePath] : []);
                const planningContext = getPropertyKeyboardPlanningContext();
                const nextPlanningFiles = planningContext.isBroadened
                    ? applyManualSortTargetOrderToPlanningScope(planningContext.files, orderedFiles, nextOrderedFiles)
                    : nextOrderedFiles;
                const plan = buildManualSortRankPlan(nextPlanningFiles, movedPaths, planningContext.rankByPath);
                const savePlan = () => {
                    const saveId = propertyKeyboardReorderSaveCounterRef.current + 1;
                    propertyKeyboardReorderSaveCounterRef.current = saveId;
                    propertyKeyboardReorderSavingRef.current = true;
                    propertyKeyboardReorderScrollPathRef.current = result.scrollPath;

                    setPropertyKeyboardReorderState({
                        propertyKey: effectivePropertySortKey,
                        order: getMarkdownPathOrder(nextOrderedFiles),
                        pendingAssignments: plan.assignments,
                        assignmentFiles: plan.files,
                        isSaving: plan.assignments.length > 0,
                        selectionKey: manualSortSelectionKey,
                        saveId
                    });
                    savePropertyKeyboardReorder(plan.files, effectivePropertySortKey, plan.assignments, manualSortSelectionKey, saveId);
                };

                if (plan.requiresCompaction) {
                    confirmManualSortCompaction(plan.assignments.length, savePlan);
                    return true;
                }

                savePlan();
                return true;
            },
            [
                canUsePropertyKeyboardReorder,
                confirmManualSortCompaction,
                effectivePropertySortKey,
                getPropertyKeyboardPlanningContext,
                getPropertyKeyboardReorderScopeFiles,
                manualSortSelectionKey,
                orderedFiles,
                savePropertyKeyboardReorder,
                selectedFile,
                selectionState.selectedFiles
            ]
        );
        const getHierarchySiblingScopeFiles = React.useCallback(
            (parentPath: string | null): TFile[] => {
                if (selectionType !== ItemType.FOLDER || !selectedFolder) {
                    return [];
                }

                const contextFilter: NavigatorContext = 'folder';
                const pinnedDisplayScope = settings.filterPinnedByFolder ? { restrictToFolderPath: selectedFolder.path } : undefined;
                const { unpinnedFiles } = partitionPinnedFiles(files, settings.pinnedNotes, contextFilter, pinnedDisplayScope);
                return unpinnedFiles.filter(file => {
                    if (file.extension !== 'md' || getParentFolderPath(file.path) !== selectedFolder.path) {
                        return false;
                    }
                    return (hierarchyService?.getParent(file.path) ?? null) === parentPath;
                });
            },
            [files, hierarchyService, selectedFolder, selectionType, settings.filterPinnedByFolder, settings.pinnedNotes]
        );
        const getHierarchyDragSelectedMarkdownPaths = React.useCallback(
            (activePath: string): Set<string> => {
                if (!selectionState.selectedFiles.has(activePath)) {
                    return new Set([activePath]);
                }

                const selectedPaths = new Set<string>();
                listItems.forEach(item => {
                    if (
                        item.type === ListPaneItemType.FILE &&
                        item.data instanceof TFile &&
                        item.data.extension === 'md' &&
                        !item.isPinned &&
                        selectionState.selectedFiles.has(item.data.path)
                    ) {
                        selectedPaths.add(item.data.path);
                    }
                });

                return selectedPaths.has(activePath) ? selectedPaths : new Set([activePath]);
            },
            [listItems, selectionState.selectedFiles]
        );
        const handleListDragSort = React.useCallback(
            (drop: ListPaneDragSortDrop): boolean => {
                if (!canUsePropertyKeyboardReorder || propertyKeyboardReorderSavingRef.current) {
                    return false;
                }

                const activeFile = app.vault.getFileByPath(drop.activePath);
                if (!(activeFile instanceof TFile) || activeFile.extension !== 'md') {
                    showNotice(strings.listPane.manualSortNonMarkdownHint, { variant: 'warning' });
                    return false;
                }

                const targetParentPath = drop.parentPath;
                if (drop.intent === 'child' && (!hierarchyService || !targetParentPath)) {
                    return false;
                }

                const dragSelectedPaths = getHierarchyDragSelectedMarkdownPaths(drop.activePath);
                const movedPaths = getTopLevelSelectedNoteTreePaths(dragSelectedPaths, path => hierarchyService?.getParent(path) ?? null);
                if (movedPaths.size === 0) {
                    return false;
                }
                if (
                    targetParentPath &&
                    (!hierarchyService ||
                        !canAttachNoteTreeSelectionToParent(movedPaths, targetParentPath, (ancestorPath, candidatePath) =>
                            hierarchyService.isDescendant(ancestorPath, candidatePath)
                        ))
                ) {
                    return false;
                }

                const movedFiles: TFile[] = [];
                for (const path of movedPaths) {
                    const movedFile = app.vault.getFileByPath(path);
                    if (!(movedFile instanceof TFile) || movedFile.extension !== 'md') {
                        return false;
                    }
                    movedFiles.push(movedFile);
                }

                const targetScopeFiles = getHierarchySiblingScopeFiles(targetParentPath);
                const targetScopePathSet = new Set(targetScopeFiles.map(file => file.path));
                let nextScopeFiles: TFile[] | null = null;
                if (drop.intent === 'child') {
                    nextScopeFiles = [...targetScopeFiles.filter(file => !movedPaths.has(file.path)), ...movedFiles];
                } else {
                    nextScopeFiles = insertManualSortMarkdownFilesAtDropTarget(targetScopeFiles, movedFiles, drop.overPath, drop.position);
                }
                if (!nextScopeFiles) {
                    return false;
                }

                const parentUpdatePaths = Array.from(movedPaths).filter(
                    path => (hierarchyService?.getParent(path) ?? null) !== targetParentPath
                );
                if (parentUpdatePaths.length > 0 && !hierarchyService) {
                    return false;
                }
                if (
                    hierarchyService &&
                    parentUpdatePaths.length > 0 &&
                    !canAttachNoteTreeSelectionToParent(movedPaths, targetParentPath, (ancestorPath, candidatePath) =>
                        hierarchyService.isDescendant(ancestorPath, candidatePath)
                    )
                ) {
                    return false;
                }

                const applyParentUpdates = (): boolean => {
                    if (!hierarchyService) {
                        return parentUpdatePaths.length === 0;
                    }

                    for (const path of parentUpdatePaths) {
                        const parentResult = hierarchyService.setParent(path, targetParentPath);
                        if (!parentResult.ok) {
                            showNotice(strings.common.unknownError, { variant: 'warning' });
                            return false;
                        }
                    }
                    return true;
                };

                const rankByPath = buildManualSortRankMap(
                    app,
                    nextScopeFiles,
                    effectivePropertySortKey,
                    activePropertyKeyboardReorderState?.pendingAssignments ?? []
                );
                const plan = buildManualSortRankPlan(nextScopeFiles, movedPaths, rankByPath);
                const movedWithinTargetScope = Array.from(movedPaths).every(path => targetScopePathSet.has(path));
                let nextScopeIndex = 0;
                const nextOrderedFiles = movedWithinTargetScope
                    ? orderedFiles.map(file => {
                          if (!targetScopePathSet.has(file.path)) {
                              return file;
                          }
                          const nextScopeFile = nextScopeFiles[nextScopeIndex];
                          nextScopeIndex += 1;
                          return nextScopeFile ?? file;
                      })
                    : orderedFiles;
                const nextOrder = getMarkdownPathOrder(nextOrderedFiles);
                const savePlan = () => {
                    if (!applyParentUpdates()) {
                        return;
                    }

                    const saveId = propertyKeyboardReorderSaveCounterRef.current + 1;
                    propertyKeyboardReorderSaveCounterRef.current = saveId;
                    propertyKeyboardReorderSavingRef.current = true;
                    propertyKeyboardReorderScrollPathRef.current = drop.activePath;

                    setPropertyKeyboardReorderState({
                        propertyKey: effectivePropertySortKey,
                        order: nextOrder,
                        pendingAssignments: plan.assignments,
                        assignmentFiles: plan.files,
                        isSaving: plan.assignments.length > 0,
                        selectionKey: manualSortSelectionKey,
                        saveId
                    });
                    savePropertyKeyboardReorder(plan.files, effectivePropertySortKey, plan.assignments, manualSortSelectionKey, saveId);
                };

                if (plan.requiresCompaction) {
                    confirmManualSortCompaction(plan.assignments.length, savePlan);
                    return true;
                }

                savePlan();
                return true;
            },
            [
                activePropertyKeyboardReorderState?.pendingAssignments,
                app,
                canUsePropertyKeyboardReorder,
                confirmManualSortCompaction,
                effectivePropertySortKey,
                getHierarchyDragSelectedMarkdownPaths,
                getHierarchySiblingScopeFiles,
                hierarchyService,
                manualSortSelectionKey,
                orderedFiles,
                savePropertyKeyboardReorder
            ]
        );

        const getManualSortNewFileContext = React.useCallback((): ManualSortNewFilePlacementContext | null => {
            const selectedFilePath = selectedFile?.path ?? null;
            const target =
                selectionType === ItemType.FOLDER && selectedFolder
                    ? { targetType: 'folder' as const, targetKey: selectedFolder.path }
                    : selectionType === ItemType.TAG && selectedTag
                      ? { targetType: 'tag' as const, targetKey: selectedTag }
                      : selectionType === ItemType.PROPERTY && selectedProperty
                        ? { targetType: 'property' as const, targetKey: selectedProperty }
                        : null;

            if (!target) {
                return null;
            }

            if (!canUsePropertyKeyboardReorder || !effectivePropertySortKey) {
                return null;
            }

            const planningContext = getPropertyKeyboardPlanningContext();
            return {
                ...target,
                propertyKey: effectivePropertySortKey,
                files: orderedFiles,
                planningFiles: planningContext.isBroadened ? planningContext.files : undefined,
                planningInsertionIndex: planningContext.insertionIndex,
                selectedFilePath,
                rankByPath: planningContext.rankByPath,
                placement: 'bottom'
            };
        }, [
            canUsePropertyKeyboardReorder,
            effectivePropertySortKey,
            getPropertyKeyboardPlanningContext,
            orderedFiles,
            selectedFolder,
            selectedFile,
            selectedProperty,
            selectedTag,
            selectionType
        ]);

        const listToolbar = useMemo(() => {
            return (
                <ListToolbar
                    isSearchActive={isSearchActive}
                    onSearchToggle={handleSearchToggle}
                    getManualSortNewFileContext={getManualSortNewFileContext}
                    useFloatingLayout={shouldUseFloatingToolbars}
                />
            );
        }, [getManualSortNewFileContext, handleSearchToggle, isSearchActive, shouldUseFloatingToolbars]);

        useEffect(() => {
            return fileSystemOps.setManualSortNewFileContextProvider(getManualSortNewFileContext);
        }, [fileSystemOps, getManualSortNewFileContext]);

        useEffect(() => {
            const scrollPath = propertyKeyboardReorderScrollPathRef.current;
            if (!scrollPath) {
                return;
            }

            const index = filePathToIndex.get(scrollPath);
            if (index === undefined) {
                return;
            }

            propertyKeyboardReorderScrollPathRef.current = null;
            scrollToIndexSafely(index, 'auto');
        }, [filePathToIndex, propertyKeyboardReorderState?.order, scrollToIndexSafely]);

        useEffect(() => {
            if (!inlineRenameFilePath || filePathToIndex.has(inlineRenameFilePath)) {
                return;
            }

            setInlineRenameFilePath(null);
        }, [filePathToIndex, inlineRenameFilePath]);

        const handleStartFileInlineRename = React.useCallback((): boolean => {
            if (!selectedFile) {
                return false;
            }

            const index = filePathToIndex.get(selectedFile.path);
            if (index === undefined) {
                return false;
            }

            setInlineRenameFilePath(selectedFile.path);
            scrollToIndexSafely(index, 'auto');
            return true;
        }, [filePathToIndex, scrollToIndexSafely, selectedFile]);

        const handleFileRenameCommit = React.useCallback(
            async (file: TFile, value: string): Promise<boolean> => {
                const shouldClose = await fileSystemOps.renameFileDisplayName(file, value);
                if (shouldClose) {
                    setInlineRenameFilePath(null);
                }
                return shouldClose;
            },
            [fileSystemOps]
        );

        const handleFileRenameCancel = React.useCallback(() => {
            setInlineRenameFilePath(null);
        }, []);

        // Expose the virtualizer instance and file lookup method via the ref
        useImperativeHandle(
            ref,
            () => ({
                getIndexOfPath: (path: string) => filePathToIndex.get(path) ?? -1,
                virtualizer: rowVirtualizer,
                scrollContainerRef: scrollContainerRef.current,
                getOrderedFiles: () => orderedFiles,
                // Allow parent components to trigger file selection programmatically
                selectFile: selectFileFromList,
                // Provide imperative adjacent navigation for command handlers
                selectAdjacentFile,
                // Toggle or modify search query to include/exclude a tag with AND/OR operator
                modifySearchWithTag,
                // Toggle or modify search query to include/exclude a property with AND/OR operator
                modifySearchWithProperty,
                // Replace the active search query with a date token
                modifySearchWithDateToken,
                // Toggle search mode on/off or focus existing search
                toggleSearch,
                executeSearchShortcut,
                getManualSortNewFileContext
            }),
            [
                filePathToIndex,
                orderedFiles,
                rowVirtualizer,
                scrollContainerRef,
                toggleSearch,
                executeSearchShortcut,
                selectFileFromList,
                selectAdjacentFile,
                modifySearchWithTag,
                modifySearchWithProperty,
                modifySearchWithDateToken,
                getManualSortNewFileContext
            ]
        );

        // Add keyboard navigation
        // Note: We pass the root container ref, not the scroll container ref.
        // This ensures keyboard events work across the entire navigator, allowing
        // users to navigate between panes (navigation <-> files) with Tab/Arrow keys.
        useListPaneKeyboard({
            enabled: true,
            items: listItems,
            virtualizer: rowVirtualizer,
            containerRef: props.rootContainerRef,
            pathToIndex: filePathToIndex,
            orderedFiles,
            orderedFileIndexMap,
            scrollToIndexSafely,
            onSelectFile: (file, options) =>
                selectFileFromList(file, {
                    markKeyboardNavigation: true,
                    suppressOpen: settings.enterToOpenFiles || options?.suppressOpen,
                    debounceOpen: options?.debounceOpen
                }),
            onScheduleKeyboardOpen: scheduleKeyboardSelectionOpen,
            onScheduleKeyboardOpenForFile: scheduleKeyboardSelectionOpenForFile,
            onCommitKeyboardOpen: commitPendingKeyboardSelectionOpen,
            onReorderPropertySort: handlePropertyKeyboardReorder,
            onStartRename: handleStartFileInlineRename
        });

        // Determine if we're showing empty state
        const isEmptySelection = !selectedFolder && !selectedTag && !selectedProperty;
        const hasNoFiles = files.length === 0;

        const shouldRenderBottomToolbar = isMobile && !isAndroid;
        const shouldRenderBottomToolbarInsidePanel = shouldRenderBottomToolbar && shouldUseFloatingToolbars;
        const shouldRenderBottomToolbarOutsidePanel = shouldRenderBottomToolbar && !shouldUseFloatingToolbars;

        // Single return with conditional content
        return (
            <div
                ref={listPaneRef}
                className={`nn-list-pane ${isSearchActive ? 'nn-search-active' : ''}`}
                style={listPaneStyle}
                data-calendar={shouldRenderCalendarOverlay ? 'true' : undefined}
            >
                {props.resizeHandleProps && <div className="nn-resize-handle" {...props.resizeHandleProps} />}
                <div className="nn-list-pane-chrome">
                    <ListPaneTitleChrome
                        onHeaderClick={handleScrollToTop}
                        isSearchActive={isSearchActive}
                        onSearchToggle={handleSearchToggle}
                        getManualSortNewFileContext={getManualSortNewFileContext}
                        shouldShowDesktopTitleArea={shouldShowDesktopTitleArea}
                    >
                        {/* Android - toolbar at top */}
                        {isMobile && isAndroid ? listToolbar : null}
                        {/* Search bar - collapsible */}
                        <div className={`nn-search-bar-container ${isSearchActive ? 'nn-search-bar-visible' : ''}`}>
                            {isSearchActive && (
                                <SearchInput
                                    searchQuery={searchQuery}
                                    onSearchQueryChange={setSearchQuery}
                                    shouldFocus={shouldFocusSearch}
                                    onFocusComplete={focusSearchComplete}
                                    onClose={closeSearch}
                                    onFocusFiles={() => {
                                        // Ensure selection exists when focusing list from search (no editor open)
                                        ensureSelectionForCurrentFilter({ openInEditor: false });
                                    }}
                                    containerRef={props.rootContainerRef}
                                    onSaveShortcut={!activeSearchShortcut ? handleSaveSearchShortcut : undefined}
                                    onRemoveShortcut={activeSearchShortcut ? handleRemoveSearchShortcut : undefined}
                                    isShortcutSaved={Boolean(activeSearchShortcut)}
                                    isShortcutDisabled={isSavingSearchShortcut}
                                    searchProvider={searchProvider}
                                />
                            )}
                        </div>
                    </ListPaneTitleChrome>
                </div>
                <div className="nn-list-pane-panel">
                    <ListPaneVirtualContent
                        listItems={listItems}
                        rowVirtualizer={rowVirtualizer}
                        scrollContainerRefCallback={scrollContainerRefCallback}
                        activeFolderDropPath={activeFolderDropPath}
                        isCompactMode={isCompactMode}
                        isEmptySelection={isEmptySelection}
                        hasNoFiles={hasNoFiles}
                        topSpacerHeight={effectiveTopSpacerHeight}
                        settings={settings}
                        pinnedGroupExpanded={pinnedGroupExpanded}
                        onPinnedGroupHeaderToggle={handlePinnedGroupHeaderToggle}
                        onListGroupHeaderToggle={handleListGroupHeaderToggle}
                        selectionType={selectionType}
                        selectedFolderPath={selectedFolderPath}
                        sortOption={effectiveSortOption}
                        searchHighlightQuery={searchHighlightQuery}
                        isFolderNavigation={selectionState.isFolderNavigation}
                        lastSelectedFilePath={lastSelectedFilePath}
                        isFileSelected={isFileSelected}
                        hoveredFilePath={hoveredFilePath}
                        suppressRowHover={isListScrolling}
                        onHoveredFilePathChange={handleHoveredFilePathChange}
                        onFileClick={handleFileItemClick}
                        onFilePointerDown={handleFileItemPointerDown}
                        onListBackgroundPointerDown={handleListBackgroundPointerDown}
                        onModifySearchWithTag={modifySearchWithTag}
                        onModifySearchWithProperty={modifySearchWithProperty}
                        localDayReference={localDayReference}
                        fileIconSize={listMeasurements.fileIconSize}
                        appearanceSettings={effectiveAppearanceSettings}
                        includeDescendantNotes={includeDescendantNotes}
                        hiddenTagVisibility={hiddenTagVisibility}
                        fileNameIconNeedles={fileNameIconNeedles}
                        visibleListPropertyKeys={visibleListPropertyKeys}
                        visibleNavigationPropertyKeys={visibleNavigationPropertyKeys}
                        fileItemStorage={fileItemStorage}
                        noteShortcutKeysByPath={noteShortcutKeysByPath}
                        onToggleNoteShortcut={toggleNoteShortcut}
                        inlineRenameFilePath={inlineRenameFilePath}
                        onFileRenameCommit={handleFileRenameCommit}
                        onFileRenameCancel={handleFileRenameCancel}
                        onFileRenameRestoreFocus={restoreListPaneFocus}
                        onNavigateToFolder={onNavigateToFolder}
                        folderDecorationModel={folderDecorationModel}
                        fileItemPillDecorationModel={fileItemPillDecorationModel}
                        fileItemPillOrderModel={fileItemPillOrderModel}
                        getSolidBackground={getSolidBackground}
                        enableDragSort={canUsePropertyKeyboardReorder && selectionType === ItemType.FOLDER && !isSearchActive}
                        selectedFilePaths={selectionState.selectedFiles}
                        onDragSort={handleListDragSort}
                        onNoteTreeToggle={handleNoteTreeToggle}
                    />
                    {/* iOS: keep the floating toolbar inside the panel */}
                    {shouldRenderBottomToolbarInsidePanel ? <div className="nn-pane-bottom-toolbar">{listToolbar}</div> : null}
                </div>
                {shouldRenderCalendarOverlay ? (
                    <div className="nn-navigation-calendar-overlay">
                        <Calendar onWeekCountChange={setCalendarWeekCount} onAddDateFilter={modifySearchWithDateToken} />
                    </div>
                ) : null}
                {shouldRenderBottomToolbarOutsidePanel ? <div className="nn-pane-bottom-toolbar">{listToolbar}</div> : null}
            </div>
        );
    })
);

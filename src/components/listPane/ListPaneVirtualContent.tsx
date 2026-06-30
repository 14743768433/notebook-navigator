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

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { App, Menu, TFile, TFolder } from 'obsidian';
import { Virtualizer } from '@tanstack/react-virtual';
import {
    DndContext,
    DragOverlay,
    MouseSensor,
    TouchSensor,
    pointerWithin,
    useDraggable,
    useDroppable,
    useSensor,
    useSensors,
    type DragMoveEvent,
    type DragOverEvent,
    type DragStartEvent,
    type Modifier
} from '@dnd-kit/core';
import { useFileSystemOps, useMetadataService, useServices } from '../../context/ServicesContext';
import { strings } from '../../i18n';
import { ItemType, ListPaneItemType, PINNED_SECTION_HEADER_KEY, type NavigationItemType } from '../../types';
import { runAsyncAction } from '../../utils/async';
import { getFolderNote, openFolderNoteFile } from '../../utils/folderNotes';
import { resolveFolderNoteClickOpenContext } from '../../utils/keyboardOpenContext';
import type { ListPaneItem } from '../../types/virtualization';
import type { NotebookNavigatorSettings, SortOption } from '../../settings/types';
import type { InclusionOperator } from '../../utils/filterSearch';
import type { FolderDecorationModel } from '../../utils/folderDecoration';
import type { NavigateToFolderOptions } from '../../hooks/useNavigatorReveal';
import { FileItem, type FileItemStorageHelpers } from '../FileItem';
import { ServiceIcon } from '../ServiceIcon';
import type { ListPaneAppearanceSettings } from '../../hooks/useListPaneAppearance';
import type { FileNameIconNeedle } from '../../utils/fileIconUtils';
import type { HiddenTagVisibility } from '../../utils/tagPrefixMatcher';
import type { FileItemPillDecorationModel } from '../../utils/fileItemPillDecoration';
import type { FileItemPillOrderModel } from '../../utils/fileItemPillOrder';
import { resolveUXIcon } from '../../utils/uxIcons';
import { hasSolidFileRowBackground } from '../../utils/colorUtils';
import { getManualSortGroupHeaderPropertyKey, shouldShowManualSortGroupHeaderProgress } from '../../utils/manualSort';
import type { ManualSortGroupHeaderData } from '../../utils/manualSort';
import { resolveFolderDecorationColors } from '../../utils/folderDecoration';
import { addManualSortGroupHeaderMenuItems } from '../../utils/contextMenu/manualSortGroupHeaderMenuItems';
import { addMergeNotesMenuItem } from '../../utils/contextMenu/mergeNotesMenuItems';
import { getMarkdownFilesInOrder } from '../../utils/noteMerge';
import { ManualSortGroupHeaderContent, ManualSortGroupHeaderProgress } from './ManualSortGroupHeaderContent';

const NOTE_TREE_INDENT_PX = 28;
const NOTE_TREE_CHILD_INTENT_THRESHOLD_PX = 28;

export interface ListPaneDragSortDrop {
    activePath: string;
    overPath: string;
    position: 'before' | 'after';
    intent: 'reorder' | 'child';
    parentPath: string | null;
    depth: number;
}

interface DragSortState extends ListPaneDragSortDrop {
    isValid: boolean;
}

interface DropAnchor {
    path: string;
    position: 'before' | 'after';
}

export interface PointerClientPosition {
    clientX: number;
    clientY: number;
}

interface FolderGroupHeaderTarget {
    folder: TFolder;
    folderNote: TFile | null;
}

interface FolderGroupHeaderSegment {
    label: string;
    path: string;
    target: FolderGroupHeaderTarget | null;
}

interface HeaderRenderModel {
    index: number;
    label: string;
    baseLabel: string;
    isFirstHeader: boolean;
    isPinnedHeader: boolean;
    collapseKey: string | null;
    isCollapsed: boolean;
    isCollapsible: boolean;
    folderGroupHeaderTarget: FolderGroupHeaderTarget | null;
    folderGroupHeaderPath: string | null;
    folderGroupHeaderSegments: FolderGroupHeaderSegment[];
    groupFilePaths: string[];
    manualSortHeaderFilePath: string | null;
    manualSortHeader: ManualSortGroupHeaderData | null;
    manualSortHeaderWordCount: number;
    manualSortHeaderTargetWordCount: number | null;
    folderIconId: string | null;
    folderColor: string | null;
    applyFolderColorToLabel: boolean;
}

interface HeaderRenderModels {
    headerModels: HeaderRenderModel[];
    headerModelByIndex: Map<number, HeaderRenderModel>;
}

type VirtualRowStyle = React.CSSProperties & Record<'--item-height', string>;

interface ListPaneGroupHeaderProps {
    header: HeaderRenderModel;
    collapseChevronIcons: {
        collapsed: string;
        expanded: string;
    };
    pinnedSectionIcon: string;
    onPinnedGroupHeaderToggle: () => void;
    onListGroupHeaderToggle: (collapseKey: string) => void;
    onFolderGroupHeaderClick: (event: React.MouseEvent<HTMLSpanElement>, target: FolderGroupHeaderTarget) => void;
    onFolderGroupHeaderMouseDown: (event: React.MouseEvent<HTMLSpanElement>, target: FolderGroupHeaderTarget) => void;
    onGroupHeaderContextMenu: (event: React.MouseEvent<HTMLDivElement>, header: HeaderRenderModel) => void;
}

interface ListPaneVirtualContentProps {
    listItems: ListPaneItem[];
    rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
    scrollContainerRefCallback: (element: HTMLDivElement | null) => void;
    activeFolderDropPath: string | null;
    isCompactMode: boolean;
    isEmptySelection: boolean;
    hasNoFiles: boolean;
    topSpacerHeight: number;
    settings: NotebookNavigatorSettings;
    pinnedGroupExpanded: boolean;
    onPinnedGroupHeaderToggle: () => void;
    onListGroupHeaderToggle: (collapseKey: string) => void;
    selectionType: NavigationItemType | null;
    selectedFolderPath: string | null;
    sortOption?: SortOption;
    searchHighlightQuery?: string;
    isFolderNavigation: boolean;
    lastSelectedFilePath: string | null;
    isFileSelected: (file: TFile) => boolean;
    hoveredFilePath: string | null;
    suppressRowHover: boolean;
    onHoveredFilePathChange: (path: string | null, pointerClientPosition: PointerClientPosition | null) => void;
    onFileClick: (file: TFile, fileIndex: number | undefined, event: React.MouseEvent) => void;
    onModifySearchWithTag: (tag: string, operator: InclusionOperator) => void;
    onModifySearchWithProperty: (key: string, value: string | null, operator: InclusionOperator) => void;
    localDayReference: Date | null;
    fileIconSize: number;
    appearanceSettings: ListPaneAppearanceSettings;
    includeDescendantNotes: boolean;
    hiddenTagVisibility: HiddenTagVisibility;
    fileNameIconNeedles: readonly FileNameIconNeedle[];
    visibleListPropertyKeys: ReadonlySet<string>;
    visibleNavigationPropertyKeys: ReadonlySet<string>;
    fileItemStorage: FileItemStorageHelpers;
    noteShortcutKeysByPath: ReadonlyMap<string, string>;
    onToggleNoteShortcut: (file: TFile, shortcutKey: string | undefined) => Promise<void>;
    inlineRenameFilePath: string | null;
    onFileRenameCommit: (file: TFile, value: string) => Promise<boolean>;
    onFileRenameCancel: () => void;
    onFileRenameRestoreFocus: () => void;
    onNavigateToFolder: (folderPath: string, options?: NavigateToFolderOptions) => void;
    folderDecorationModel: FolderDecorationModel;
    fileItemPillDecorationModel: FileItemPillDecorationModel;
    fileItemPillOrderModel: FileItemPillOrderModel;
    getSolidBackground: (color?: string | null) => string | undefined;
    enableDragSort?: boolean;
    selectedFilePaths?: ReadonlySet<string>;
    onDragSort?: (drop: ListPaneDragSortDrop) => boolean;
    onNoteTreeToggle?: (nodeKey: string) => void;
}

function getItemAt<T>(items: T[], index: number): T | undefined {
    if (index < 0 || index >= items.length) {
        return undefined;
    }

    return items[index];
}

function buildDateGroupLabelsByIndex(listItems: ListPaneItem[]): (string | null)[] {
    const labelsByIndex = new Array<string | null>(listItems.length).fill(null);
    let currentDateGroupLabel: string | null = null;

    listItems.forEach((item, index) => {
        if (item.type === ListPaneItemType.HEADER && item.headerKind === 'date' && typeof item.data === 'string') {
            currentDateGroupLabel = item.data;
            return;
        }

        if (item.type === ListPaneItemType.FILE) {
            labelsByIndex[index] = currentDateGroupLabel;
        }
    });

    return labelsByIndex;
}

function getFirstFileAfterHeader(listItems: ListPaneItem[], headerIndex: number): TFile | null {
    for (let listIndex = headerIndex + 1; listIndex < listItems.length; listIndex += 1) {
        const item = getItemAt(listItems, listIndex);

        if (item?.type === ListPaneItemType.HEADER_SPACER) {
            continue;
        }

        if (item?.type === ListPaneItemType.FILE && item.data instanceof TFile) {
            return item.data;
        }

        return null;
    }

    return null;
}

function resolveGroupMergeOutputFolder(app: App, header: HeaderRenderModel, files: readonly TFile[]): TFolder {
    if (header.folderGroupHeaderPath) {
        if (header.folderGroupHeaderPath === '/') {
            return app.vault.getRoot();
        }

        const folder = app.vault.getFolderByPath(header.folderGroupHeaderPath);
        if (folder instanceof TFolder) {
            return folder;
        }
    }

    const firstFile = files[0];
    return firstFile?.parent instanceof TFolder ? firstFile.parent : app.vault.getRoot();
}

function findActiveHeaderModel(headers: HeaderRenderModel[], firstVisibleIndex: number | null): HeaderRenderModel | null {
    if (firstVisibleIndex === null || headers.length === 0) {
        return null;
    }

    let low = 0;
    let high = headers.length - 1;
    let activeHeader: HeaderRenderModel | null = null;

    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const header = headers[middle];
        if (header.index <= firstVisibleIndex) {
            activeHeader = header;
            low = middle + 1;
            continue;
        }

        high = middle - 1;
    }

    return activeHeader;
}

function shouldHideCollapsedHeaderSeparator(header: HeaderRenderModel | null): boolean {
    return header?.isCollapsed === true;
}

function shouldHideManualSortGoalHeaderSeparator(header: HeaderRenderModel | null): boolean {
    return header?.manualSortHeader
        ? shouldShowManualSortGroupHeaderProgress(header.manualSortHeader, header.manualSortHeaderTargetWordCount)
        : false;
}

function getActivatorPoint(event: Event): { x: number; y: number } | null {
    if ('clientX' in event && 'clientY' in event) {
        const pointerEvent = event as MouseEvent;
        return { x: pointerEvent.clientX, y: pointerEvent.clientY };
    }

    const touchEvent = event as TouchEvent;
    const touch = touchEvent.touches?.[0] ?? touchEvent.changedTouches?.[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
}

const snapDragOverlayCenterToPointer: Modifier = ({ activatorEvent, activeNodeRect, overlayNodeRect, transform }) => {
    const activatorPoint = activatorEvent ? getActivatorPoint(activatorEvent) : null;
    const overlayBaseRect = overlayNodeRect ?? activeNodeRect;
    if (!activatorPoint || !overlayBaseRect) {
        return transform;
    }

    const pointerNow = {
        x: activatorPoint.x + transform.x,
        y: activatorPoint.y + transform.y
    };
    return {
        ...transform,
        x: pointerNow.x - overlayBaseRect.width / 2 - overlayBaseRect.left,
        y: pointerNow.y - overlayBaseRect.height / 2 - overlayBaseRect.top
    };
};

function getRowElement(doc: Document, path: string): HTMLElement | null {
    const rows = doc.querySelectorAll<HTMLElement>('[data-dnd-file-path]');
    for (const row of rows) {
        if (row.dataset.dndFilePath === path) {
            return row;
        }
    }
    return null;
}

function getCurrentPoint(startPoint: { x: number; y: number } | null, delta: { x: number; y: number }): { x: number; y: number } | null {
    return startPoint ? { x: startPoint.x + delta.x, y: startPoint.y + delta.y } : null;
}

interface DraggableVirtualRowProps {
    file: TFile | null;
    canDrag: boolean;
    className: string;
    style: VirtualRowStyle;
    index: number;
    depth: number;
    hasChildren: boolean;
    isExpanded: boolean;
    treeNodeKey: string | null;
    dropState: DragSortState | null;
    onNoteTreeToggle?: (nodeKey: string) => void;
    children: React.ReactNode;
}

function DraggableVirtualRow({
    file,
    canDrag,
    className,
    style,
    index,
    depth,
    hasChildren,
    isExpanded,
    treeNodeKey,
    dropState,
    onNoteTreeToggle,
    children
}: DraggableVirtualRowProps) {
    const rowId = file?.path ?? `row-${style.top}`;
    const {
        attributes,
        listeners,
        setNodeRef: setDraggableNodeRef,
        isDragging
    } = useDraggable({
        id: rowId,
        data: { type: 'list-file', path: file?.path ?? '' },
        disabled: !canDrag
    });
    const { setNodeRef: setDroppableNodeRef } = useDroppable({
        id: rowId,
        data: { type: 'list-file', path: file?.path ?? '' },
        disabled: !canDrag
    });
    const setNodeRef = useCallback(
        (node: HTMLDivElement | null) => {
            setDraggableNodeRef(node);
            setDroppableNodeRef(node);
        },
        [setDraggableNodeRef, setDroppableNodeRef]
    );
    const rowClasses = [className];
    if (isDragging) {
        rowClasses.push('nn-list-drag-source');
    }
    if (file && dropState?.intent === 'child' && dropState.parentPath === file.path && dropState.isValid) {
        rowClasses.push('nn-list-drag-parent-target');
    }
    const showDropIndicator = file && dropState?.intent === 'reorder' && dropState.overPath === file.path && dropState.isValid;
    const rowStyle = {
        ...style,
        '--nn-note-tree-depth': depth.toString()
    } as VirtualRowStyle & Record<'--nn-note-tree-depth', string>;
    const indicatorStyle = showDropIndicator ? ({ '--nn-drop-depth': dropState.depth.toString() } as React.CSSProperties) : undefined;
    const handleToggleClick = useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            event.preventDefault();
            event.stopPropagation();
            if (treeNodeKey) {
                onNoteTreeToggle?.(treeNodeKey);
            }
        },
        [onNoteTreeToggle, treeNodeKey]
    );

    return (
        <div
            ref={setNodeRef}
            className={rowClasses.join(' ')}
            style={rowStyle}
            data-index={index}
            data-dnd-file-path={file?.path}
            {...(canDrag ? attributes : {})}
            {...(canDrag ? listeners : {})}
        >
            {showDropIndicator ? (
                <div className={`nn-list-drop-indicator nn-list-drop-indicator-${dropState.position}`} style={indicatorStyle} />
            ) : null}
            {file && hasChildren ? (
                <button
                    type="button"
                    className="nn-note-tree-toggle"
                    aria-label={isExpanded ? strings.listPane.collapseGroup : strings.listPane.expandGroup}
                    onClick={handleToggleClick}
                    onPointerDown={event => event.stopPropagation()}
                    tabIndex={-1}
                >
                    <ServiceIcon iconId={isExpanded ? 'lucide-chevron-down' : 'lucide-chevron-right'} />
                </button>
            ) : null}
            {children}
        </div>
    );
}

function ListPaneGroupHeader({
    header,
    collapseChevronIcons,
    pinnedSectionIcon,
    onPinnedGroupHeaderToggle,
    onListGroupHeaderToggle,
    onFolderGroupHeaderClick,
    onFolderGroupHeaderMouseDown,
    onGroupHeaderContextMenu
}: ListPaneGroupHeaderProps) {
    const folderGroupHeaderTarget = header.folderGroupHeaderTarget;
    const manualSortHeader = header.manualSortHeader;
    const hasFolderPathSegments = header.folderGroupHeaderSegments.length > 0;
    const isClickableFolderGroupHeader = Boolean(folderGroupHeaderTarget) && !header.isPinnedHeader && !hasFolderPathSegments;
    const hasManualSortGoal =
        manualSortHeader !== null && shouldShowManualSortGroupHeaderProgress(manualSortHeader, header.manualSortHeaderTargetWordCount);
    const folderColor = header.folderColor ?? undefined;
    const folderIconStyle = folderColor ? { color: folderColor } : undefined;
    const folderLabelStyle = header.applyFolderColorToLabel && folderColor ? { color: folderColor } : undefined;
    const handleCollapseButtonClick = useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            if (header.isPinnedHeader) {
                onPinnedGroupHeaderToggle();
                return;
            }

            if (header.collapseKey) {
                onListGroupHeaderToggle(header.collapseKey);
            }
        },
        [header.collapseKey, header.isPinnedHeader, onListGroupHeaderToggle, onPinnedGroupHeaderToggle]
    );
    const headerClasses = ['nn-list-group-header'];
    if (header.isPinnedHeader) {
        headerClasses.push('nn-pinned-section-header');
    }
    if (manualSortHeader) {
        headerClasses.push('nn-list-group-header--manual-sort');
    }
    const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => onGroupHeaderContextMenu(event, header);
    const textClassName = `nn-list-group-header-text ${
        isClickableFolderGroupHeader ? 'nn-list-group-header-text--folder-note' : ''
    } ${header.applyFolderColorToLabel ? 'nn-list-group-header-text--custom-color' : ''}`;
    const folderPathClassName = `${textClassName} nn-list-group-header-path`;
    const renderFolderGroupHeaderText = () => {
        if (hasFolderPathSegments) {
            return (
                <span className={folderPathClassName} style={folderLabelStyle}>
                    {header.folderGroupHeaderSegments.map((segment, index) => {
                        const segmentTarget = segment.target;
                        const segmentClassName = `nn-list-group-header-folder-segment ${
                            segmentTarget ? 'nn-list-group-header-text--folder-note' : ''
                        }`;
                        return (
                            <React.Fragment key={segment.path}>
                                {index > 0 ? (
                                    <span className="nn-list-group-header-path-separator" aria-hidden="true">
                                        /
                                    </span>
                                ) : null}
                                <span
                                    className={segmentClassName}
                                    onClick={segmentTarget ? event => onFolderGroupHeaderClick(event, segmentTarget) : undefined}
                                    onMouseDown={segmentTarget ? event => onFolderGroupHeaderMouseDown(event, segmentTarget) : undefined}
                                >
                                    {segment.label}
                                </span>
                            </React.Fragment>
                        );
                    })}
                </span>
            );
        }

        return (
            <span
                className={textClassName}
                style={folderLabelStyle}
                onClick={folderGroupHeaderTarget ? event => onFolderGroupHeaderClick(event, folderGroupHeaderTarget) : undefined}
                onMouseDown={folderGroupHeaderTarget ? event => onFolderGroupHeaderMouseDown(event, folderGroupHeaderTarget) : undefined}
            >
                {header.label}
            </span>
        );
    };

    const headerRow = (
        <div className={headerClasses.join(' ')} onContextMenu={hasManualSortGoal ? undefined : handleContextMenu}>
            {manualSortHeader ? (
                <ManualSortGroupHeaderContent
                    header={manualSortHeader}
                    wordCount={header.manualSortHeaderWordCount}
                    targetWordCount={header.manualSortHeaderTargetWordCount}
                />
            ) : (
                <>
                    {header.isPinnedHeader && pinnedSectionIcon ? (
                        <ServiceIcon
                            iconId={pinnedSectionIcon}
                            className="nn-list-group-header-icon nn-pinned-section-icon"
                            aria-hidden={true}
                        />
                    ) : null}
                    {!header.isPinnedHeader && header.folderIconId ? (
                        <ServiceIcon
                            iconId={header.folderIconId}
                            className="nn-list-group-header-icon nn-list-group-header-folder-icon"
                            aria-hidden={true}
                            data-has-color={folderColor ? 'true' : 'false'}
                            style={folderIconStyle}
                        />
                    ) : null}
                    {renderFolderGroupHeaderText()}
                </>
            )}
            {header.isCollapsible ? (
                <button
                    type="button"
                    className="nn-list-group-header-collapse-button"
                    aria-label={header.isCollapsed ? strings.listPane.expandGroup : strings.listPane.collapseGroup}
                    aria-expanded={!header.isCollapsed}
                    onClick={handleCollapseButtonClick}
                >
                    <ServiceIcon
                        iconId={header.isCollapsed ? collapseChevronIcons.collapsed : collapseChevronIcons.expanded}
                        className="nn-list-group-header-icon"
                        aria-hidden={true}
                    />
                </button>
            ) : null}
        </div>
    );

    if (hasManualSortGoal) {
        return (
            <div className="nn-manual-sort-group-header-shell" onContextMenu={handleContextMenu}>
                {headerRow}
                <ManualSortGroupHeaderProgress
                    header={manualSortHeader}
                    wordCount={header.manualSortHeaderWordCount}
                    targetWordCount={header.manualSortHeaderTargetWordCount}
                />
            </div>
        );
    }

    return headerRow;
}

function getHoveredFilePathFromTarget(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) {
        return null;
    }

    const fileElement = target.closest('.nn-file');
    return fileElement instanceof HTMLElement ? (fileElement.dataset.path ?? null) : null;
}

export function getHoveredFilePathAtPointer(
    scrollContainer: HTMLElement | null,
    pointerClientPosition: PointerClientPosition | null
): string | null {
    if (!scrollContainer || !pointerClientPosition) {
        return null;
    }

    const ownerDocument = scrollContainer.ownerDocument;
    if (!ownerDocument) {
        return null;
    }

    const target = ownerDocument.elementFromPoint(pointerClientPosition.clientX, pointerClientPosition.clientY);
    if (!(target instanceof Element) || !scrollContainer.contains(target)) {
        return null;
    }

    return getHoveredFilePathFromTarget(target);
}

function isFileListItem(item: ListPaneItem | undefined): item is ListPaneItem & { type: typeof ListPaneItemType.FILE; data: TFile } {
    return item?.type === ListPaneItemType.FILE && item.data instanceof TFile;
}

export function ListPaneVirtualContent({
    listItems,
    rowVirtualizer,
    scrollContainerRefCallback,
    activeFolderDropPath,
    isCompactMode,
    isEmptySelection,
    hasNoFiles,
    topSpacerHeight,
    settings,
    pinnedGroupExpanded,
    onPinnedGroupHeaderToggle,
    onListGroupHeaderToggle,
    selectionType,
    selectedFolderPath,
    sortOption,
    searchHighlightQuery,
    isFolderNavigation,
    lastSelectedFilePath,
    isFileSelected,
    hoveredFilePath,
    suppressRowHover,
    onHoveredFilePathChange,
    onFileClick,
    onModifySearchWithTag,
    onModifySearchWithProperty,
    localDayReference,
    fileIconSize,
    appearanceSettings,
    includeDescendantNotes,
    hiddenTagVisibility,
    fileNameIconNeedles,
    visibleListPropertyKeys,
    visibleNavigationPropertyKeys,
    fileItemStorage,
    noteShortcutKeysByPath,
    onToggleNoteShortcut,
    inlineRenameFilePath,
    onFileRenameCommit,
    onFileRenameCancel,
    onFileRenameRestoreFocus,
    onNavigateToFolder,
    folderDecorationModel,
    fileItemPillDecorationModel,
    fileItemPillOrderModel,
    getSolidBackground,
    enableDragSort = false,
    selectedFilePaths = new Set<string>(),
    onDragSort,
    onNoteTreeToggle
}: ListPaneVirtualContentProps) {
    const { app, commandQueue, hierarchyService, isMobile, plugin } = useServices();
    const fileSystemOps = useFileSystemOps();
    const metadataService = useMetadataService();
    const collapseChevronIcons = useMemo(
        () => ({
            collapsed: resolveUXIcon(settings.interfaceIcons, 'nav-tree-expand'),
            expanded: resolveUXIcon(settings.interfaceIcons, 'nav-tree-collapse')
        }),
        [settings.interfaceIcons]
    );
    const pinnedSectionIcon = useMemo(() => resolveUXIcon(settings.interfaceIcons, 'list-pinned'), [settings.interfaceIcons]);
    const manualSortGroupHeaderPropertyKey = useMemo(
        () =>
            getManualSortGroupHeaderPropertyKey({
                manualSortGroupHeaderProperty: settings.manualSortGroupHeaderProperty,
                manualSortPropertyKey: settings.manualSortPropertyKey
            }),
        [settings.manualSortGroupHeaderProperty, settings.manualSortPropertyKey]
    );

    const folderGroupHeaderTargets = useMemo(() => {
        const targets = new Map<string, FolderGroupHeaderTarget>();

        const addTarget = (folderPath: string | null | undefined) => {
            if (!folderPath || targets.has(folderPath)) {
                return;
            }

            const folder = app.vault.getFolderByPath(folderPath);
            if (!folder) {
                return;
            }

            const folderNote =
                settings.enableFolderNotes && settings.enableFolderNoteLinks
                    ? getFolderNote(folder, {
                          enableFolderNotes: settings.enableFolderNotes,
                          folderNoteName: settings.folderNoteName,
                          folderNoteNamePattern: settings.folderNoteNamePattern
                      })
                    : null;

            targets.set(folderPath, { folder, folderNote });
        };

        listItems.forEach(item => {
            if (item.type !== ListPaneItemType.HEADER) {
                return;
            }

            addTarget(item.headerFolderPath);
            item.headerFolderSegments?.forEach(segment => {
                addTarget(segment.path);
            });
        });

        return targets;
    }, [
        app.vault,
        listItems,
        settings.enableFolderNoteLinks,
        settings.enableFolderNotes,
        settings.folderNoteName,
        settings.folderNoteNamePattern
    ]);

    const { headerModels, headerModelByIndex } = useMemo<HeaderRenderModels>(() => {
        const models: HeaderRenderModel[] = [];
        const modelsByIndex = new Map<number, HeaderRenderModel>();
        let hasSeenFile = false;

        // Build one header model set for both virtual rows and the sticky overlay so click behavior stays identical.
        listItems.forEach((item, index) => {
            if (item.type === ListPaneItemType.FILE) {
                hasSeenFile = true;
                return;
            }

            if (item.type !== ListPaneItemType.HEADER || typeof item.data !== 'string') {
                return;
            }

            const headerFolderPath = item.headerFolderPath ?? null;
            const isPinnedHeader = item.key === PINNED_SECTION_HEADER_KEY;
            const collapseKey = item.collapseKey ?? null;
            const isCollapsed = isPinnedHeader ? !pinnedGroupExpanded : item.isCollapsed === true;
            const manualSortHeader = item.headerKind === 'manual-sort-custom' ? (item.manualSortHeader ?? null) : null;
            const baseLabel = manualSortHeader?.title ?? item.data;
            const folderGroupDecorationPath = item.headerKind === 'folder' ? (headerFolderPath ?? '/') : null;
            const folderGroupHeaderSegments =
                item.headerKind === 'folder' && settings.showFolderGroupPaths
                    ? (item.headerFolderSegments ?? []).map(segment => ({
                          label: segment.label,
                          path: segment.path,
                          target: folderGroupHeaderTargets.get(segment.path) ?? null
                      }))
                    : [];
            let folderIconId: string | null = null;
            let folderColor: string | null = null;
            const shouldResolveFolderIcon = settings.showFolderIcons;
            const shouldResolveFolderColor = settings.showFolderIcons || !settings.colorIconOnly;
            if (folderGroupDecorationPath !== null && (shouldResolveFolderIcon || shouldResolveFolderColor)) {
                const folderDisplayData = metadataService.getFolderDisplayData(folderGroupDecorationPath, {
                    includeDisplayName: false,
                    includeColor: shouldResolveFolderColor,
                    includeBackgroundColor: false,
                    includeIcon: shouldResolveFolderIcon,
                    includeInheritedColors: shouldResolveFolderColor
                });
                folderIconId = shouldResolveFolderIcon
                    ? (folderDisplayData.icon ??
                      resolveUXIcon(
                          settings.interfaceIcons,
                          folderGroupDecorationPath === '/' ? 'nav-folder-root' : isCollapsed ? 'nav-folder-closed' : 'nav-folder-open'
                      ))
                    : null;
                if (shouldResolveFolderColor) {
                    folderColor =
                        resolveFolderDecorationColors({
                            model: folderDecorationModel,
                            folderPath: folderGroupDecorationPath,
                            color: folderDisplayData.color,
                            backgroundColor: undefined
                        }).color ?? null;
                }
            }
            const model: HeaderRenderModel = {
                index,
                label: item.data,
                baseLabel,
                isFirstHeader: models.length === 0 && !hasSeenFile,
                isPinnedHeader,
                collapseKey,
                isCollapsed,
                isCollapsible: isPinnedHeader || collapseKey !== null,
                folderGroupHeaderTarget: headerFolderPath !== null ? (folderGroupHeaderTargets.get(headerFolderPath) ?? null) : null,
                folderGroupHeaderPath: item.headerKind === 'folder' ? (headerFolderPath ?? '/') : null,
                folderGroupHeaderSegments,
                groupFilePaths: item.groupFilePaths ?? [],
                manualSortHeaderFilePath: item.headerKind === 'manual-sort-custom' ? (item.manualSortHeaderFilePath ?? null) : null,
                manualSortHeader,
                manualSortHeaderWordCount: item.manualSortHeaderWordCount ?? 0,
                manualSortHeaderTargetWordCount: item.manualSortHeaderTargetWordCount ?? null,
                folderIconId,
                folderColor,
                applyFolderColorToLabel: folderColor !== null && !settings.colorIconOnly
            };
            models.push(model);
            modelsByIndex.set(index, model);
        });

        return {
            headerModels: models,
            headerModelByIndex: modelsByIndex
        };
    }, [
        folderDecorationModel,
        folderGroupHeaderTargets,
        listItems,
        metadataService,
        pinnedGroupExpanded,
        settings.colorIconOnly,
        settings.showFolderGroupPaths,
        settings.interfaceIcons,
        settings.showFolderIcons
    ]);
    const dateGroupLabelByIndex = useMemo(() => buildDateGroupLabelsByIndex(listItems), [listItems]);

    const handleFolderGroupHeaderClick = useCallback(
        (event: React.MouseEvent<HTMLSpanElement>, target: FolderGroupHeaderTarget) => {
            event.stopPropagation();
            const folderNote = target.folderNote;

            const navigateOptions: NavigateToFolderOptions = {
                source: 'manual',
                suppressAutoSelect: Boolean(folderNote)
            };
            onNavigateToFolder(target.folder.path, navigateOptions);

            if (!folderNote) {
                return;
            }

            const openContext = resolveFolderNoteClickOpenContext(
                event,
                settings.folderNoteOpenLocation,
                settings.multiSelectModifier,
                isMobile
            );

            if (
                openContext === 'right-sidebar' &&
                settings.showNearestFolderNoteInSidebar &&
                !(selectionType === ItemType.FOLDER && selectedFolderPath === target.folder.path)
            ) {
                return;
            }

            runAsyncAction(() =>
                openFolderNoteFile({
                    app,
                    commandQueue,
                    folder: target.folder,
                    folderNote,
                    context: openContext,
                    openInRightSidebar: folderNoteFile => plugin.openFolderNoteInRightSidebar(folderNoteFile)
                })
            );
        },
        [
            app,
            commandQueue,
            isMobile,
            onNavigateToFolder,
            plugin,
            selectedFolderPath,
            selectionType,
            settings.folderNoteOpenLocation,
            settings.multiSelectModifier,
            settings.showNearestFolderNoteInSidebar
        ]
    );

    const handleFolderGroupHeaderMouseDown = useCallback(
        (event: React.MouseEvent<HTMLSpanElement>, target: FolderGroupHeaderTarget) => {
            const folderNote = target.folderNote;
            if (event.button !== 1 || !folderNote) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            onNavigateToFolder(target.folder.path, { source: 'manual', suppressAutoSelect: true });

            runAsyncAction(() =>
                openFolderNoteFile({
                    app,
                    commandQueue,
                    folder: target.folder,
                    folderNote,
                    context: 'tab'
                })
            );
        },
        [app, commandQueue, onNavigateToFolder]
    );

    const handleGroupHeaderContextMenu = useCallback(
        (event: React.MouseEvent<HTMLDivElement>, header: HeaderRenderModel) => {
            const groupFiles = header.groupFilePaths
                .map(path => app.vault.getFileByPath(path))
                .filter((file): file is TFile => file instanceof TFile);
            const markdownGroupFiles = getMarkdownFilesInOrder(groupFiles);
            const menu = new Menu();
            let hasItems = false;
            if (markdownGroupFiles.length >= 2) {
                hasItems = addMergeNotesMenuItem({
                    menu,
                    app,
                    commandQueue,
                    fileSystemOps,
                    files: markdownGroupFiles,
                    outputFolder: resolveGroupMergeOutputFolder(app, header, markdownGroupFiles),
                    defaultOutputName: header.baseLabel || strings.modals.mergeNotes.outputNamePlaceholder,
                    title: strings.contextMenu.file.mergeNotesInGroup
                });
            }

            if (manualSortGroupHeaderPropertyKey && header.manualSortHeaderFilePath) {
                const file = app.vault.getFileByPath(header.manualSortHeaderFilePath);
                if (file instanceof TFile && file.extension === 'md') {
                    if (hasItems) {
                        menu.addSeparator();
                    }
                    const addedManualSortItems = addManualSortGroupHeaderMenuItems({
                        menu,
                        app,
                        file,
                        propertyKey: manualSortGroupHeaderPropertyKey,
                        metadataService
                    });
                    hasItems = hasItems || addedManualSortItems;
                }
            }

            if (!hasItems) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            menu.showAtMouseEvent(event.nativeEvent);
        },
        [app, commandQueue, fileSystemOps, manualSortGroupHeaderPropertyKey, metadataService]
    );

    const handleListMouseMove = useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            onHoveredFilePathChange(getHoveredFilePathFromTarget(event.target), {
                clientX: event.clientX,
                clientY: event.clientY
            });
        },
        [onHoveredFilePathChange]
    );

    const handleListMouseLeave = useCallback(() => {
        onHoveredFilePathChange(null, null);
    }, [onHoveredFilePathChange]);

    const hasFileCustomBackground = useCallback(
        (item: ListPaneItem | undefined) => {
            if (item?.type !== ListPaneItemType.FILE || !(item.data instanceof TFile)) {
                return false;
            }

            const file = item.data;
            const taskUnfinished = settings.showFileBackgroundUnfinishedTask
                ? fileItemStorage.getDB().getFile(file.path)?.taskUnfinished
                : undefined;
            return hasSolidFileRowBackground({
                customBackgroundColor: metadataService.getFileBackgroundColor(file.path),
                taskUnfinished,
                showUnfinishedTaskBackground: settings.showFileBackgroundUnfinishedTask,
                unfinishedTaskBackgroundColor: settings.unfinishedTaskBackgroundColor,
                getSolidBackground
            });
        },
        [
            fileItemStorage,
            getSolidBackground,
            metadataService,
            settings.showFileBackgroundUnfinishedTask,
            settings.unfinishedTaskBackgroundColor
        ]
    );
    const isFileVisuallySelected = useCallback(
        (file: TFile): boolean => {
            return isFileSelected(file) || (isFolderNavigation && lastSelectedFilePath === file.path);
        },
        [isFileSelected, isFolderNavigation, lastSelectedFilePath]
    );

    const virtualItems = rowVirtualizer.getVirtualItems();
    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
        useSensor(TouchSensor, { activationConstraint: { distance: 6 } })
    );
    const dragStartPointRef = useRef<{ x: number; y: number } | null>(null);
    const [activeDragPath, setActiveDragPath] = useState<string | null>(null);
    const [dropState, setDropState] = useState<DragSortState | null>(null);
    const fileItemInfoByPath = useMemo(() => {
        const info = new Map<
            string,
            {
                item: ListPaneItem;
                index: number;
                depth: number;
                parentPath: string | null;
            }
        >();
        listItems.forEach((item, index) => {
            if (item.type === ListPaneItemType.FILE && item.data instanceof TFile) {
                info.set(item.data.path, {
                    item,
                    index,
                    depth: item.depth ?? 0,
                    parentPath: item.hierarchyParentPath ?? null
                });
            }
        });
        return info;
    }, [listItems]);
    const getDropMaxDepth = useCallback(
        (insertionIndex: number, activePath: string): number => {
            for (let index = insertionIndex - 1; index >= 0; index -= 1) {
                const candidate = listItems[index];
                if (candidate?.type === ListPaneItemType.FILE && candidate.data instanceof TFile && candidate.data.path !== activePath) {
                    return (candidate.depth ?? 0) + 1;
                }
            }
            return 0;
        },
        [listItems]
    );
    const resolveParentForDropDepth = useCallback(
        (insertionIndex: number, depth: number, activePath: string): string | null => {
            if (depth <= 0) {
                return null;
            }

            for (let index = insertionIndex - 1; index >= 0; index -= 1) {
                const candidate = listItems[index];
                if (
                    candidate?.type === ListPaneItemType.FILE &&
                    candidate.data instanceof TFile &&
                    candidate.data.path !== activePath &&
                    (candidate.depth ?? 0) === depth - 1
                ) {
                    return candidate.data.path;
                }
            }
            return null;
        },
        [listItems]
    );
    const resolveSiblingDropAnchor = useCallback(
        (
            insertionIndex: number,
            parentPath: string | null,
            activePath: string,
            preferredPosition: 'before' | 'after'
        ): DropAnchor | null => {
            const isTargetSibling = (
                item: ListPaneItem | undefined
            ): item is ListPaneItem & { type: typeof ListPaneItemType.FILE; data: TFile } => {
                return (
                    item?.type === ListPaneItemType.FILE &&
                    item.data instanceof TFile &&
                    item.data.path !== activePath &&
                    item.data.extension === 'md' &&
                    !item.isPinned &&
                    (item.hierarchyParentPath ?? null) === parentPath
                );
            };

            const findPrevious = (): DropAnchor | null => {
                for (let index = insertionIndex - 1; index >= 0; index -= 1) {
                    const candidate = listItems[index];
                    if (isTargetSibling(candidate)) {
                        return { path: candidate.data.path, position: 'after' };
                    }
                }
                return null;
            };

            const findNext = (): DropAnchor | null => {
                for (let index = insertionIndex; index < listItems.length; index += 1) {
                    const candidate = listItems[index];
                    if (isTargetSibling(candidate)) {
                        return { path: candidate.data.path, position: 'before' };
                    }
                }
                return null;
            };

            return preferredPosition === 'before' ? (findNext() ?? findPrevious()) : (findPrevious() ?? findNext());
        },
        [listItems]
    );
    const buildDropState = useCallback(
        (
            activePath: string,
            overPath: string,
            point: { x: number; y: number } | null,
            delta: { x: number; y: number }
        ): DragSortState | null => {
            const overInfo = fileItemInfoByPath.get(overPath);
            const activeInfo = fileItemInfoByPath.get(activePath);
            const rowElement = getRowElement(activeDocument, overPath);
            if (!overInfo || !activeInfo || !rowElement || !point) {
                return null;
            }

            const rect = rowElement.getBoundingClientRect();
            const position = point.y < rect.top + rect.height / 2 ? 'before' : 'after';
            const overDepth = overInfo.depth;
            const insertionIndex = position === 'after' ? overInfo.index + 1 : overInfo.index;
            const maxDepth = getDropMaxDepth(insertionIndex, activePath);
            const projectedDepth = activeInfo.depth + Math.round(delta.x / NOTE_TREE_INDENT_PX);
            const requestedDepth = Math.max(0, Math.min(maxDepth, projectedDepth));
            const childIntent = delta.x >= NOTE_TREE_CHILD_INTENT_THRESHOLD_PX;
            const selectedMarkdownCount = Array.from(selectedFilePaths).filter(
                path => fileItemInfoByPath.get(path)?.item.data instanceof TFile
            ).length;

            if (childIntent) {
                const isValid =
                    activePath !== overPath &&
                    selectedMarkdownCount <= 1 &&
                    overInfo.item.data instanceof TFile &&
                    !overInfo.item.isPinned &&
                    !activeInfo.item.isPinned &&
                    overInfo.item.data.extension === 'md' &&
                    activeInfo.item.data instanceof TFile &&
                    activeInfo.item.data.extension === 'md' &&
                    !(hierarchyService?.isDescendant(activePath, overPath) ?? false);
                return {
                    activePath,
                    overPath,
                    position: 'after',
                    intent: 'child',
                    parentPath: overPath,
                    depth: overDepth + 1,
                    isValid
                };
            }

            const parentPath = resolveParentForDropDepth(insertionIndex, requestedDepth, activePath);
            const dropAnchor = resolveSiblingDropAnchor(insertionIndex, parentPath, activePath, position);
            if (!dropAnchor) {
                return null;
            }
            const dropAnchorInfo = fileItemInfoByPath.get(dropAnchor.path);
            const isValid =
                activePath !== dropAnchor.path &&
                Boolean(dropAnchorInfo) &&
                !dropAnchorInfo?.item.isPinned &&
                !activeInfo.item.isPinned &&
                dropAnchorInfo?.item.data instanceof TFile &&
                dropAnchorInfo.item.data.extension === 'md' &&
                activeInfo.item.data instanceof TFile &&
                activeInfo.item.data.extension === 'md' &&
                (parentPath === null || !(hierarchyService?.isDescendant(activePath, parentPath) ?? false));
            return {
                activePath,
                overPath: dropAnchor.path,
                position: dropAnchor.position,
                intent: 'reorder',
                parentPath,
                depth: requestedDepth,
                isValid
            };
        },
        [fileItemInfoByPath, getDropMaxDepth, hierarchyService, resolveParentForDropDepth, resolveSiblingDropAnchor, selectedFilePaths]
    );
    const updateDropStateFromEvent = useCallback(
        (event: DragMoveEvent | DragOverEvent) => {
            const activePath = String(event.active.id);
            const overPath = event.over?.id ? String(event.over.id) : '';
            if (!activePath || !overPath) {
                setDropState(null);
                return;
            }
            const point = getCurrentPoint(dragStartPointRef.current, event.delta);
            setDropState(buildDropState(activePath, overPath, point, event.delta));
        },
        [buildDropState]
    );
    const handleDragStart = useCallback((event: DragStartEvent) => {
        const activePath = String(event.active.id);
        setActiveDragPath(activePath);
        dragStartPointRef.current = getActivatorPoint(event.activatorEvent);
    }, []);
    const handleDragMove = useCallback(
        (event: DragMoveEvent) => {
            updateDropStateFromEvent(event);
        },
        [updateDropStateFromEvent]
    );
    const handleDragOver = useCallback(
        (event: DragOverEvent) => {
            updateDropStateFromEvent(event);
        },
        [updateDropStateFromEvent]
    );
    const handleDragEnd = useCallback(() => {
        const finalDropState = dropState ?? null;
        setActiveDragPath(null);
        setDropState(null);
        dragStartPointRef.current = null;
        if (!finalDropState?.isValid) {
            return;
        }
        onDragSort?.({
            activePath: finalDropState.activePath,
            overPath: finalDropState.overPath,
            position: finalDropState.position,
            intent: finalDropState.intent,
            parentPath: finalDropState.parentPath,
            depth: finalDropState.depth
        });
    }, [dropState, onDragSort]);
    const handleDragCancel = useCallback(() => {
        setActiveDragPath(null);
        setDropState(null);
        dragStartPointRef.current = null;
    }, []);
    const activeDragFile = activeDragPath ? (fileItemInfoByPath.get(activeDragPath)?.item.data ?? null) : null;
    const scrollOffset = rowVirtualizer.scrollOffset ?? 0;
    const stickyGroupHeaders = settings.stickyGroupHeaders;
    const stickyOffset =
        stickyGroupHeaders && (topSpacerHeight === 0 || scrollOffset >= topSpacerHeight) ? Math.max(0, scrollOffset + 0.5) : null;
    const firstVisibleItem =
        stickyOffset !== null && listItems.length > 0 ? rowVirtualizer.getVirtualItemForOffset(stickyOffset) : undefined;
    const stickyHeader = stickyGroupHeaders ? findActiveHeaderModel(headerModels, firstVisibleItem?.index ?? null) : null;

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={pointerWithin}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
        >
            <div
                ref={scrollContainerRefCallback}
                className={`nn-list-pane-scroller ${!isEmptySelection && !hasNoFiles && isCompactMode ? 'nn-compact-mode' : ''}`}
                data-drop-zone={activeFolderDropPath ? 'folder' : undefined}
                data-drop-path={activeFolderDropPath ?? undefined}
                data-allow-internal-drop={activeFolderDropPath ? 'false' : undefined}
                data-allow-external-drop={activeFolderDropPath ? 'true' : undefined}
                data-pane="files"
                role="list"
                tabIndex={-1}
                onMouseMove={handleListMouseMove}
                onMouseLeave={handleListMouseLeave}
            >
                {stickyHeader ? (
                    <div className="nn-list-sticky-header">
                        <ListPaneGroupHeader
                            header={stickyHeader}
                            collapseChevronIcons={collapseChevronIcons}
                            pinnedSectionIcon={pinnedSectionIcon}
                            onPinnedGroupHeaderToggle={onPinnedGroupHeaderToggle}
                            onListGroupHeaderToggle={onListGroupHeaderToggle}
                            onFolderGroupHeaderClick={handleFolderGroupHeaderClick}
                            onFolderGroupHeaderMouseDown={handleFolderGroupHeaderMouseDown}
                            onGroupHeaderContextMenu={handleGroupHeaderContextMenu}
                        />
                    </div>
                ) : null}
                <div className="nn-list-pane-content">
                    {isEmptySelection ? (
                        <div className="nn-empty-state">
                            <div className="nn-empty-message">{strings.listPane.emptyStateNoSelection}</div>
                        </div>
                    ) : hasNoFiles ? (
                        <div className="nn-empty-state">
                            <div className="nn-empty-message">{strings.listPane.emptyStateNoNotes}</div>
                        </div>
                    ) : listItems.length > 0 ? (
                        <div
                            className="nn-virtual-container"
                            style={{
                                height: `${rowVirtualizer.getTotalSize()}px`
                            }}
                        >
                            {virtualItems.map(virtualItem => {
                                const item = getItemAt(listItems, virtualItem.index);
                                if (!item) {
                                    return null;
                                }

                                const nextItem = getItemAt(listItems, virtualItem.index + 1);
                                const previousItem = getItemAt(listItems, virtualItem.index - 1);
                                const isFileRow = isFileListItem(item);
                                const isSelected = isFileRow && isFileVisuallySelected(item.data);
                                const isPreviousFileSelected = isFileListItem(previousItem) && isFileVisuallySelected(previousItem.data);
                                const isNextFileSelected = isFileListItem(nextItem) && isFileVisuallySelected(nextItem.data);
                                const hasCustomBackground = hasFileCustomBackground(item);
                                const previousHasCustomBackground = isFileRow && hasFileCustomBackground(previousItem);
                                const nextHasCustomBackground = isFileRow && hasFileCustomBackground(nextItem);
                                const hasPreviousCustomBackground = hasCustomBackground && previousHasCustomBackground;
                                const hasNextCustomBackground = isFileRow && nextHasCustomBackground;
                                const hasFilledBackground = isFileRow && (isSelected || hasCustomBackground);
                                const hasPreviousFilledBackground =
                                    hasFilledBackground &&
                                    isFileListItem(previousItem) &&
                                    (isPreviousFileSelected || previousHasCustomBackground);
                                const hasNextFilledBackground =
                                    hasFilledBackground && isFileListItem(nextItem) && (isNextFileSelected || nextHasCustomBackground);
                                const isLastFile =
                                    isFileRow &&
                                    (virtualItem.index === listItems.length - 1 ||
                                        (nextItem &&
                                            (nextItem.type === ListPaneItemType.HEADER ||
                                                nextItem.type === ListPaneItemType.HEADER_SPACER ||
                                                nextItem.type === ListPaneItemType.TOP_SPACER ||
                                                nextItem.type === ListPaneItemType.BOTTOM_SPACER)));

                                const hasSelectedAbove = isFileRow && isPreviousFileSelected;
                                const hasSelectedBelow = isFileRow && isNextFileSelected;

                                const groupHeaderLabel =
                                    item.type === ListPaneItemType.FILE ? (dateGroupLabelByIndex[virtualItem.index] ?? null) : null;
                                const shortcutKey =
                                    item.type === ListPaneItemType.FILE && item.data instanceof TFile
                                        ? noteShortcutKeysByPath.get(item.data.path)
                                        : undefined;
                                const isInlineRenaming =
                                    item.type === ListPaneItemType.FILE &&
                                    item.data instanceof TFile &&
                                    item.data.path === inlineRenameFilePath;

                                const headerModel = headerModelByIndex.get(virtualItem.index) ?? null;
                                const firstFileAfterHeader = headerModel ? getFirstFileAfterHeader(listItems, virtualItem.index) : null;
                                const shouldHideHeaderSeparatorForGroup =
                                    shouldHideCollapsedHeaderSeparator(headerModel) || shouldHideManualSortGoalHeaderSeparator(headerModel);
                                const hideFileSeparator =
                                    item.type === ListPaneItemType.FILE &&
                                    ((isSelected && !hasSelectedBelow) || (!isSelected && isNextFileSelected));
                                const hideHeaderSeparator = firstFileAfterHeader !== null && isFileVisuallySelected(firstFileAfterHeader);
                                const hideSeparator = hideFileSeparator || hideHeaderSeparator;

                                const virtualItemStyle: VirtualRowStyle = {
                                    top: Math.max(0, virtualItem.start),
                                    '--item-height': `${virtualItem.size}px`
                                };
                                const virtualItemClasses = ['nn-virtual-item'];
                                if (item.type === ListPaneItemType.FILE) {
                                    virtualItemClasses.push('nn-virtual-file-item');
                                    if (
                                        item.depth !== undefined ||
                                        item.hasChildren !== undefined ||
                                        item.hierarchyParentPath !== undefined
                                    ) {
                                        virtualItemClasses.push('nn-note-tree-row');
                                    }
                                }
                                if (headerModel) {
                                    virtualItemClasses.push('nn-virtual-list-group-header');
                                }
                                if (shouldHideHeaderSeparatorForGroup) {
                                    virtualItemClasses.push('nn-hide-list-group-header-separator');
                                }
                                if (isLastFile) {
                                    virtualItemClasses.push('nn-last-file');
                                }
                                if (hideSeparator) {
                                    virtualItemClasses.push('nn-hide-separator-selection');
                                }
                                if (hasFilledBackground) {
                                    virtualItemClasses.push('nn-virtual-file-item-has-filled-background');
                                }
                                if (hasPreviousFilledBackground) {
                                    virtualItemClasses.push('nn-virtual-file-item-has-filled-background-previous');
                                }
                                if (hasNextFilledBackground) {
                                    virtualItemClasses.push('nn-virtual-file-item-has-filled-background-next');
                                }
                                if (hasCustomBackground) {
                                    virtualItemClasses.push('nn-virtual-file-item-has-custom-background');
                                }
                                if (hasPreviousCustomBackground) {
                                    virtualItemClasses.push('nn-virtual-file-item-has-custom-background-previous');
                                }
                                if (hasNextCustomBackground) {
                                    virtualItemClasses.push('nn-virtual-file-item-has-custom-background-next');
                                }
                                const rowFile = item.type === ListPaneItemType.FILE && item.data instanceof TFile ? item.data : null;
                                const canDragRow = Boolean(
                                    enableDragSort && rowFile && rowFile.extension === 'md' && !item.isPinned && !isInlineRenaming
                                );
                                const noteTreeNodeKey = rowFile ? `${selectedFolderPath ?? ''}\u0001${rowFile.path}` : null;

                                return (
                                    <DraggableVirtualRow
                                        key={virtualItem.key}
                                        file={rowFile}
                                        canDrag={canDragRow}
                                        className={virtualItemClasses.join(' ')}
                                        style={virtualItemStyle}
                                        index={virtualItem.index}
                                        depth={item.type === ListPaneItemType.FILE ? (item.depth ?? 0) : 0}
                                        hasChildren={item.type === ListPaneItemType.FILE && item.hasChildren === true}
                                        isExpanded={item.type === ListPaneItemType.FILE && item.isExpanded === true}
                                        treeNodeKey={noteTreeNodeKey}
                                        dropState={dropState}
                                        onNoteTreeToggle={onNoteTreeToggle}
                                    >
                                        {headerModel ? (
                                            <ListPaneGroupHeader
                                                header={headerModel}
                                                collapseChevronIcons={collapseChevronIcons}
                                                pinnedSectionIcon={pinnedSectionIcon}
                                                onPinnedGroupHeaderToggle={onPinnedGroupHeaderToggle}
                                                onListGroupHeaderToggle={onListGroupHeaderToggle}
                                                onFolderGroupHeaderClick={handleFolderGroupHeaderClick}
                                                onFolderGroupHeaderMouseDown={handleFolderGroupHeaderMouseDown}
                                                onGroupHeaderContextMenu={handleGroupHeaderContextMenu}
                                            />
                                        ) : item.type === ListPaneItemType.HEADER_SPACER ? (
                                            <div className="nn-list-group-header-spacer" />
                                        ) : item.type === ListPaneItemType.TOP_SPACER ? (
                                            <div className="nn-list-top-spacer" style={{ height: `${topSpacerHeight}px` }} />
                                        ) : item.type === ListPaneItemType.BOTTOM_SPACER ? (
                                            <div className="nn-list-bottom-spacer" />
                                        ) : item.type === ListPaneItemType.FILE && item.data instanceof TFile ? (
                                            <FileItem
                                                key={item.key}
                                                file={item.data}
                                                isSelected={isSelected}
                                                hasSelectedAbove={hasSelectedAbove}
                                                hasSelectedBelow={hasSelectedBelow}
                                                showQuickActionsPanel={
                                                    !isInlineRenaming && !suppressRowHover && hoveredFilePath === item.data.path
                                                }
                                                onFileClick={onFileClick}
                                                fileIndex={item.fileIndex}
                                                selectionType={selectionType}
                                                groupHeaderLabel={groupHeaderLabel}
                                                sortOption={sortOption}
                                                parentFolder={item.parentFolder}
                                                isPinned={item.isPinned}
                                                searchQuery={searchHighlightQuery}
                                                searchMeta={item.searchMeta}
                                                isHidden={Boolean(item.isHidden)}
                                                onModifySearchWithTag={onModifySearchWithTag}
                                                onModifySearchWithProperty={onModifySearchWithProperty}
                                                localDayReference={localDayReference}
                                                fileIconSize={fileIconSize}
                                                appearanceSettings={appearanceSettings}
                                                includeDescendantNotes={includeDescendantNotes}
                                                hiddenTagVisibility={hiddenTagVisibility}
                                                fileNameIconNeedles={fileNameIconNeedles}
                                                visiblePropertyKeys={visibleListPropertyKeys}
                                                visibleNavigationPropertyKeys={visibleNavigationPropertyKeys}
                                                fileItemStorage={fileItemStorage}
                                                shortcutKey={shortcutKey}
                                                onToggleNoteShortcut={onToggleNoteShortcut}
                                                folderDecorationModel={folderDecorationModel}
                                                fileItemPillDecorationModel={fileItemPillDecorationModel}
                                                fileItemPillOrderModel={fileItemPillOrderModel}
                                                getSolidBackground={getSolidBackground}
                                                disableNativeDrag={enableDragSort}
                                                manualSortDisabled={enableDragSort && item.data.extension !== 'md'}
                                                inlineRename={
                                                    isInlineRenaming
                                                        ? {
                                                              onCommit: onFileRenameCommit,
                                                              onCancel: onFileRenameCancel,
                                                              onRestoreFocus: onFileRenameRestoreFocus
                                                          }
                                                        : undefined
                                                }
                                            />
                                        ) : null}
                                    </DraggableVirtualRow>
                                );
                            })}
                        </div>
                    ) : null}
                </div>
            </div>
            <DragOverlay adjustScale={false} dropAnimation={null} modifiers={[snapDragOverlayCenterToPointer]}>
                {activeDragFile instanceof TFile ? (
                    <div className="nn-list-drag-overlay">
                        <ServiceIcon iconId="lucide-file-text" />
                        <span>{activeDragFile.basename}</span>
                    </div>
                ) : null}
            </DragOverlay>
        </DndContext>
    );
}

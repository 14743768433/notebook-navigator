# Notebook Navigator Drag Sort + Note Hierarchy Implementation Report

Date: 2026-06-30

## Verification Commands

- `npm run lint` - Pass
- `npm test -- tests/services/HierarchyService.test.ts tests/utils/manualSort.test.ts tests/hooks/listPaneData/listItems.test.ts` - Pass, 86 tests
- `npm run build` - Pass
- `npm test` - Pass, 148 files / 1586 tests
- `npm run lint:styles` - Pass
- `git diff --check` - Pass, with existing CRLF warning for generated `styles.css`

Manual Obsidian QA has not been run in this report. Items that require live app confirmation are marked as code/test verified rather than live verified.

## `default-drag-sort.md` Acceptance

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Folder top no longer shows persistent "Manual sort: sort_index" instructions | Pass, code verified | Sort menu no longer enters explicit manual sort mode in `src/hooks/useListActions.ts`; default render path stays in `ListPaneVirtualContent`. |
| 2 | Markdown files can be dragged without clicking a manual-sort button first | Pass, code verified | `ListPaneVirtualContent` wraps the virtual list in `DndContext` and enables row drag when folder sort is `sort_index`. |
| 3 | Folders without appearance overrides default to compact mode | Pass, code verified | `src/settings/defaultSettings.ts` changes `defaultListMode` to `compact`. |
| 4 | User can still switch back to standard; explicit standard overrides survive | Pass, inherited behavior | Only the default value changed; per-node appearance override plumbing was not changed. |
| 5 | Dragging Markdown updates and persists `sort_index` | Pass, code/test verified | Drag handler in `src/components/ListPane.tsx` reuses manual-sort rank planning and save pipeline; `tests/utils/manualSort.test.ts` passes. |
| 6 | Sorting survives switching folders | Pass, code verified | Uses existing persisted frontmatter `sort_index` plus folder sort override path; no transient edit-mode state is required. |
| 7 | Sorting survives Obsidian restart | Pass, code verified | `sort_index` remains in note frontmatter through existing save pipeline. Live restart not manually tested. |
| 8 | Non-Markdown sorting restrictions remain | Pass, code verified | Drag is enabled only for Markdown rows; non-Markdown rows keep the low-noise disabled path. |
| 9 | Save failure gives user feedback | Pass, inherited behavior | Drag save reuses existing `savePropertyKeyboardReorder` failure handling and warning notices. |
| 10 | Click, keyboard navigation, search, filtering do not regress | Pass, automated coverage plus code review | Full test suite passes; drag sort disabled during search and native click handlers remain unchanged. Live app QA still recommended. |

## `folder-note-hierarchy.md` Acceptance

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Notes in the same folder can render as a tree | Pass, test verified | `buildListItems` assembles DFS rows with depth; hierarchy list tests cover tree order. |
| 2 | Every tree node maps to a real Markdown note | Pass, test verified | Tree assembly only uses current-folder unpinned Markdown `TFile` rows. |
| 3 | Nodes with children can expand/collapse | Pass, test/code verified | `ExpansionContext` persists note-tree expansion; virtual rows render chevrons and toggle actions. |
| 4 | User can drag notes to reorder siblings | Pass, code verified | Same-parent drops call `reorderManualSortMarkdownFilesAtDropTarget` and update sibling `sort_index`. |
| 5 | User can drag a note to become another note's child | Pass, code verified | Child-intent drops call `HierarchyService.setParent` and append within target child scope. |
| 6 | Reorder vs child intent has distinct visual feedback | Pass, code verified | Reorder draws a depth-aware insertion line; child intent highlights the target parent row. |
| 7 | Hierarchy relation and sibling order persist after drop | Pass, service/test verified | `HierarchyService` writes `hierarchy.json`; sibling order uses existing `sort_index` pipeline. |
| 8 | Switching folders preserves tree hierarchy | Pass, code verified | List data subscribes to `HierarchyService`; relations are loaded from service instead of component-local state. |
| 9 | Restart preserves tree hierarchy | Pass, service/test verified | `HierarchyService` loads/saves `.obsidian/plugins/notebook-navigator/hierarchy.json`; live restart not manually tested. |
| 10 | Cycles are blocked | Pass, test verified | `HierarchyService.test.ts` covers self-parent and descendant-parent rejection. |
| 11 | Click, keyboard navigation, search, filtering do not regress | Pass, automated coverage plus code review | Full tests pass; hierarchy drag is limited to folder `sort_index` mode and disabled during search. Live app QA still recommended. |

## Notes

- Specs were synchronized so cross-level sibling insertion resets the parent according to the insertion-line depth.
- Pinned notes stay flat and out of the hierarchy.
- Non-Markdown files stay out of hierarchy drag/edit behavior.
- Existing untracked file `Sumink-Exports-2026-05-02T07-43-43-962Z.zip` was left untouched.

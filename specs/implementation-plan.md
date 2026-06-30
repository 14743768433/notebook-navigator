# 实现计划

本文件是 [默认拖动排序](default-drag-sort.md) 与 [文件夹内笔记层级](folder-note-hierarchy.md) 两个 spec 的**统一落地计划**（“怎么做”）。spec 文件负责“做什么/为什么/验收”，本文件负责“改哪个文件、改什么函数、为什么这样改”。

调研基准：代码快照 2026-06-30，main 分支。文中 `文件:行号` 为当时定位，实现前需复核。

---

## 0. 总览与关键架构判断

### 0.1 核心决策：统一到虚拟化列表，退役第二套渲染器

当前存在**两套列表渲染器**：

- `src/components/listPane/ListPaneVirtualContent.tsx` —— 普通浏览列表，基于 TanStack Virtual，已支持手动排序自定义分组头（`manualSortHeader`）。
- `src/components/listPane/ManualSortListContent.tsx` —— 显式“手动排序编辑模式”，基于 `@dnd-kit`，**非虚拟化**，带顶部说明面板 + “完成”按钮。

两个 spec 的目标（默认可拖、树状层级）都要发生在**普通浏览列表**里，且都要虚拟化。长期维护两套渲染器是负担。因此：

> **决策**：把拖动能力（含后续层级拖动）直接并入虚拟化的 `ListPaneVirtualContent`，复用已有的“重排 + 保存”管道；**退役 `ManualSortListContent` 与显式编辑模式 `manualSortEditState`**。其自定义分组头 / 字数目标进度等能力，虚拟列表已具备（`ListPaneVirtualContent` 已渲染 `manualSortHeader`），不会丢。

这同时解决了 `default-drag-sort.md` 标注的“非虚拟化渲染器常驻会卡”的最大工程风险——因为我们根本不让那套非虚拟渲染器常驻，而是给已经虚拟化的列表加拖动。

### 0.2 可直接复用的现成能力（避免重复造轮子）

| 能力 | 位置 | 说明 |
|------|------|------|
| `sort_index` 分数排名 / 插入 / 压缩 | `src/utils/manualSort.ts` | `buildManualSortRankPlan` / `buildManualSortInsertionRankPlan` / `writeManualSortAssignments` / `MANUAL_SORT_RANK_STEP` |
| 方向移动（同级换序，含多选） | `src/utils/manualSort.ts` | `moveManualSortSelectionByDirection` / `moveManualSortMarkdownFiles` / `partitionManualSortFiles` |
| **原位重排 + 保存管道（无编辑模式）** | `src/components/ListPane.tsx` | `propertyKeyboardReorderState` + `handlePropertyKeyboardReorder`(:1331) + `savePropertyKeyboardReorder` + `getPropertyKeyboardReorderScopeFiles`(:1305)。当前只绑键盘（`onReorderPropertySort`，:1600） |
| 每文件夹排序方式持久化 | `src/utils/sortUtils.ts` | `getEffectiveListSort`(:503) 读 `settings.folderSortOverrides[path]`(:492) |
| dnd-kit 拖动配置 | `src/utils/dndConfig.ts` | `typeFilteredCollisionDetection` / `verticalAxisOnly`；传感器 `MouseSensor`/`TouchSensor` 用法见 `ManualSortListContent.tsx:781` |
| 列表项构建 | `src/hooks/listPaneData/listItems.ts` | `buildListItems` / `pushFileItem` / `ListPaneItem` |
| 折叠状态 localStorage 持久化（已跨重启） | `src/context/ExpansionContext.tsx` | `collapsedListGroups` 经 `STORAGE_KEYS.collapsedListGroupsKey` 持久化 |
| 文件重命名/删除时 path-keyed 数据同步 | `src/services/metadata/FileMetadataService.ts` | `handleFileRename`/`handleFileDelete`（经 `MetadataService.ts:518-523`），现已同步 `pinnedNotes`/`fileIcons` 等 |
| 文件夹路径 records 同步先例 | `src/services/fileSystem/FolderPathSettingsSync.ts` | path-keyed 记录在重命名时迁移的写法范例 |

### 0.3 dnd-kit 与 TanStack Virtual 共存方案（保守路线）

虚拟列表只挂载可视行，`@dnd-kit/sortable` 的 `verticalListSortingStrategy` 依赖完整 DOM 与 transform 位移——拖动时原行滚出视口会导致 active item 卸载、碰撞抖动、自动滚动落点错乱。**因此明确不使用 sortable strategy**，改用更底层、更可控的组合：

1. 在 `nn-list-pane-scroller` 外层包一个 `DndContext`。
2. 每个可视文件行用 `useDraggable` + `useDroppable` 注册（**不用 `useSortable` / `SortableContext`**）。
3. **必须使用 `DragOverlay`** 渲染被拖行的影子，脱离虚拟容器的 transform 体系，避免原行卸载导致预览丢失。`DragOverlay` 内只渲染一个**精简版影子行**（仅图标 + 标题），**不把完整 `FileItem` 塞进 portal**——`FileItem` 依赖大量 context/props，精简行更省事、也不易出 context 问题。
4. **排序预览用自定义插入线**（在目标行上/下缘画一条线），**不依赖 sortable 的 transform 动画**移动真实 DOM。
5. 放手时不依赖 dnd-kit 内部 index，用 `active.id` / `over.id`（文件路径）走**现有重排管道**重算顺序（见 1.4）。
6. 复用 `verticalAxisOnly` modifier（阶段一仅纵向）；阶段三层级拖动会去掉该限制以读取水平位移。
7. **先做最小原型**：在虚拟列表里验证「虚拟滚动 + dnd-kit 自动滚动 + drop 落点正确」三者协同，再铺开正式实现。

> 备选方案（更保守但成本更高）：保留 `ManualSortListContent` 思路但为其引入虚拟化。否决理由：要把字数进度头、分组、多选等全部在新虚拟容器里重写一遍，且和层级阶段冲突。

---

## 1. 阶段一 —— 默认拖动排序（Spec 1）

目标：`sort_index` 文件夹默认即可在普通列表里拖动排序，无编辑模式、无说明面板，默认 compact。

### 1.1 默认列表模式改为 compact
- **改** `src/settings/defaultSettings.ts:300`：`defaultListMode: 'standard'` → `'compact'`。
- 不写迁移逻辑（单人使用，已确认全量切 compact）。`useListPaneAppearance.ts` 的 `resolveListMode` 逐节点覆盖逻辑不动，显式设过的覆盖仍生效。
- **验证**：`getDefaultListMode`（`useListPaneAppearance.ts:45`）返回 compact；已显式设 standard 的 folderAppearance 不被改。

### 1.2 退役显式编辑模式，拖动改为 sort_index 文件夹常驻
- **改** `src/components/ListPane.tsx`：
  - 移除 `manualSortEditState` 整套状态机及其渲染分支（:333、:1658 的 `manualSortEditState ? <ManualSortListContent> : <ListPaneVirtualContent>` 改为始终渲染虚拟列表）。
  - 移除 `handleManualSortStart` / `handleManualSortDone` / `ManualSortListContent` 相关 props 装配。
  - 顶部 `onManualSortStart` 改为“切换该文件夹排序方式到 `sort_index`”的入口（写 `folderSortOverrides`，复用现有排序方式设置写入路径），不再进入编辑模式。
- **删除/退役** `src/components/listPane/ManualSortListContent.tsx`（及其专属子组件/样式），确认无其它引用后移除。
- 拖动启用条件 = 现有派生量 `isManualSortActive`（`ListPane.tsx:445`）+ folder 视图。阶段一不在 tag/property/搜索启用（spec 决定 4）。

### 1.3 把指针拖动加入虚拟列表
- **改** `src/components/listPane/ListPaneVirtualContent.tsx`：
  - 新增 prop：`enableDragSort: boolean`（= `isManualSortActive && selectionType===FOLDER && !isSearchActive`）、`onReorder`（复用，见 1.4）、`selectedFiles`、`rankByPath`。
  - 外层 `nn-list-pane-content` / scroller 包 `DndContext`（sensors / `typeFilteredCollisionDetection` / `verticalAxisOnly` 从 `ManualSortListContent` 迁移）。
  - 文件行（:998 渲染 `FileItem` 处）当 `enableDragSort` 时用 `useDraggable` + `useDroppable`（按 0.3，**不用 `useSortable`**）；非 md 行（`partitionManualSortFiles` 判定）不可拖、作为静态 droppable 跳过。
  - 顶层渲染 `DragOverlay` + 精简影子行；目标位置画自定义插入线（新增 `nn-list-drop-indicator` 样式）。
  - `FileItem` 传 `disableNativeDrag={enableDragSort}`、`manualSortDisabled`，避免与原生 drag manager（移动到文件夹）冲突——逻辑同 `ManualSortListContent.tsx:269`。
- **新增** `src/hooks/useListDragSort.ts`（从 `ManualSortListContent` 的 `handleDragStart/handleDragEnd/handleDragCancel` 抽出，并改为 draggable/droppable + overlay 模型），产出 `DndContext` 所需回调与当前拖动/落点状态；desktop 整行可拖、mobile 用 grip 手柄（沿用现有 `isMobile` 分支）。

### 1.4 复用“重排 + 保存”管道
- `propertyKeyboardReorderState` 当前只服务键盘。**做法**：把 `handlePropertyKeyboardReorder`（`ListPane.tsx:1331`）泛化为接收“下一个有序文件序列 + movedPaths”的 `applyListReorder`，键盘（方向）与指针拖动（落点）都调它：
  - 键盘路径：维持现有 `moveManualSortSelectionByDirection` 算出 `result.files`。
  - 拖动路径：用 `active.id`/`over.id` 走 `moveManualSortMarkdownFiles(orderedFiles, activePath, overPath, selectedFiles)` 算出 nextFiles。
  - 两路径汇合后统一 `buildManualSortRankPlan` → `savePropertyKeyboardReorder` → `writeManualSortAssignments`。压缩确认（`requiresCompaction`）走现有 `confirmManualSortCompaction`。
- 多选批量拖动（spec 决定 5）天然支持：`getManualSortSelectedMarkdownPaths` 已在管道里。

### 1.5 去面板 / 低打扰提示
- 常驻说明面板随 `ManualSortListContent` 退役一并消失。
- 非 Markdown 不可排序项：不加常驻文字；仅当用户尝试拖动非 md 行时弹一次性 toast（`showNotice`，`src/utils/noticeUtils.ts`）。i18n 文案在 `src/i18n/locales/*` 增一条（保留 `manualSortNonMarkdownHint` 复用）。
- 保存反馈：成功无提示；失败走现有 `getLocalizedManualSortWriteFailureMessage` + warning toast（`ListPane.tsx:563` 已有）。

### 1.6 测试
- 复用并扩展 `tests/utils/manualSort.test.ts`。
- 新增/扩展 `tests/hooks/listPaneData/listItems.test.ts`：sort_index 文件夹下顺序正确、非 md 置底。
- 手测项对照 `default-drag-sort.md` 验收标准 1–10（重点：切走再回来、重启 Obsidian 后顺序保留 = `folderSortOverrides` + frontmatter 双持久化）。

---

## 2. 阶段二 —— 层级数据层（Spec 2 数据）

目标：建立单父关系存储、路径同步、树构建与 `sort_index` 作用域收窄。本阶段不含交互。

### 2.1 层级关系服务 `HierarchyService`
- **新增** `src/services/hierarchy/HierarchyService.ts`：
  - 内存模型：`Map<string, string>`（`子文件路径 → 父文件路径`，严格单值单父）+ 反向索引 `Map<父, Set<子>>`。
  - 磁盘 schema（**版本化 envelope**）：
    ```json
    {
      "version": 1,
      "parents": { "child.md": "parent.md" },
      "updatedAt": 1780000000000
    }
    ```
    - `version` 供后续 schema migration（如多父时把 `parents` 的值升级为数组）。
    - `updatedAt` **仅用于人工调试同步冲突，不参与自动合并**——仍是整文件 last-write-wins。
    - 加载时按 `version` 走迁移；文件缺失/损坏时回退空表并告警，不阻塞列表。
  - 持久化：单独文件 `.obsidian/plugins/notebook-navigator/hierarchy.json`，经 `app.vault.adapter.read/write/exists`（先例：`src/services/FileSystemService.ts` 等已用 adapter）。读：启动加载进内存；写：debounce 后整文件写回。
  - 公开 API：
    - `getParent(path): string | null`
    - `getChildren(path): string[]`（反向索引，内存维护）
    - `setParent(childPath, parentPath | null)`（含防环校验，见下）
    - `getDescendants(path): Set<string>` / `isDescendant(ancestor, candidate)`（防环 + 拖动校验用）
    - `applyRename(oldPath, newPath)` / `applyDelete(path)`（见 2.2）
    - `getVersion(): number` / `subscribe(listener): () => void`（变更订阅，见下）
  - **防环**：`setParent` 前校验 `parentPath !== childPath` 且 `!isDescendant(childPath, parentPath)`；违例拒绝并返回错误。
  - **变更通知（必需）**：服务非 React state，必须主动通知 UI，否则 `hierarchy.json` 写了但列表不刷新。每次 `setParent`/`applyRename`/`applyDelete`/`load` 成功后 bump 内部 version 并通知 listeners；`useListPaneData`（或新增上层 hook）订阅 version 触发 `listItems` 重建。**version bump 需合并**：批量操作（如文件夹重命名连发数十个 `applyRename`）期间合并为一次通知（microtask 末尾 flush 或短 debounce），避免重建风暴。
  - 注入：在 `ServicesContext` 注册，与 `tagTreeService`/`propertyTreeService` 并列（它们也是 subscribe 模式，照抄）。
- **同步风险**（写进 spec 已注明）：该文件被 Obsidian 官方 Sync 带走需用户勾选社区插件配置同步；整文件 last-write-wins。单人多设备冲突概率低，无需额外合并逻辑。

### 2.2 path-keyed 同步（重命名/移动/删除）
- **挂钩** `src/services/workspace/registerWorkspaceEvents.ts`，作为与 `metadataService`/`recentNotesService` **并列的第三个 peer** 调用（**不要塞进 `FileMetadataService`**——层级树不属于文件 metadata 的职责）：
  - rename 分支（:182-184 附近，现已并列 `recentNotesService.renameEntry` + `metadataService.handleFileRename`）追加 `hierarchyService.applyRename(oldPath, file.path)`。
  - delete 分支（:263-266 附近，现已并列 `recentNotesService.removeEntry` + `metadataService.handleFileDelete`）追加 `hierarchyService.applyDelete(file.path)`。
- `applyRename`：同时迁移**作为 key（子）**和**作为 value（父）**的所有引用。
- `applyDelete`：删除该 child 条目；其原有子节点 `parent` 回退根级（删除其条目），即子笔记不消失、只升到根（spec“父删除→子回退根级”）。
- 文件夹重命名：NN 已对文件夹下文件逐个发 rename 事件，逐个 `applyRename` 即可覆盖（配合 2.1 的 bump 合并，避免重建风暴）。

### 2.3 树构建（listItems 改造）
- **改** `src/hooks/listPaneData/listItems.ts` 的 `buildListItems`：
  - 当 `isManualSortActive` 且文件夹内存在父子关系（`HierarchyService` 在该文件夹路径集合内有边）时，进入**树模式**：
    1. 取当前文件夹内 md 文件，按 `HierarchyService` 组装为森林（根 = 无父 或 父不在当前文件夹内）。
    2. 每个父节点下的兄弟按 `sort_index`（`getCachedManualSortRank`）排序——复用现有 `sortFiles`/比较器。
    3. 先序遍历（DFS）输出扁平序列，对每个 `pushFileItem` 写入新字段 `depth`、`hasChildren`、`isExpanded`、`parentPath`。
    4. 折叠节点的子树跳过（用展开状态，见 3.2）。
  - 无父子关系时维持阶段一的扁平列表（spec 决定：有关系才自动成树）。
- **改** `src/types/virtualization.ts` 的 `ListPaneItem`：新增可选字段 `depth?: number`、`hasChildren?: boolean`、`isExpanded?: boolean`、`hierarchyParentPath?: string | null`。

### 2.4 `sort_index` 作用域收窄到兄弟集合
- **不重新分配编号**：`sort_index` 仍是文件夹内全局数值，组装树时仅在“同一父节点的兄弟序列”内用作相对排序键。
- 重排保存时，`buildManualSortRankPlan` 的输入 `nextFiles` 改为“受影响兄弟集合的新顺序”，而非整文件夹；`movedPaths` 为被拖笔记。其余分数排名/压缩逻辑零改动。

---

## 3. 阶段三 —— 层级交互层（Spec 2 交互）

### 3.1 树渲染（缩进 + 展开折叠控件）
- **改** `src/components/listPane/ListPaneVirtualContent.tsx` 文件行渲染：
  - 按 `item.depth` 加左缩进（新增 CSS 变量 `--nn-tree-indent`，乘以 depth；样式放 `src/styles/sections/list-files.css`）。
  - `item.hasChildren` 时在行首渲染展开/折叠 chevron（复用导航树图标 `nav-tree-expand/collapse`，见 `ListPaneVirtualContent.tsx:487`）。
  - 缩进参考导航树 `IndentGuideColumns.tsx`，可选复用其缩进引导线。

### 3.2 折叠状态持久化（跨重启）
- **复用** `ExpansionContext` 模式。新增 `expandedNoteTreeNodes: Set<string>` 状态 + `STORAGE_KEYS.expandedNoteTreeKey`，localStorage 持久化（与 `collapsedListGroups` 同写法，`ExpansionContext.tsx:283`）。
- key 形如 `folderPathnotePath`，避免跨文件夹串扰。
- 新增 action `TOGGLE_NOTE_TREE_EXPANDED`；`buildListItems` 读该集合决定 `isExpanded` 与子树是否跳过。
- 删除/重命名时清理失效 key（复用 `CLEANUP_DELETED_*` 模式）。

### 3.3 两意图拖动判定（核心难点）
- **改** 阶段一的 `useListDragSort`：层级模式下去掉 `verticalAxisOnly`，在 `onDragOver`/`onDragMove` 读取指针相对目标行的**水平位移**：
  - 水平位移 < 缩进阈值 → **同级排序**：在目标行上/下缘画横向插入线（落点用 y 判定 before/after）。插入线所在缩进层级决定新父节点，允许把子节点拖回根级。
  - 水平位移 ≥ 缩进阈值（向右）→ **变为子节点**：高亮目标父行 + 显示缩进后的预览占位。
  - 阈值设为一个缩进单位（`--nn-tree-indent`），规则固定可学习；放手前必须有明确预览（spec 强约束：不得误判）。
- 反馈层：新增覆盖元素（插入线 / 父节点高亮）。落点意图存入拖动状态，`onDragEnd` 据此分流：
  - 同级 → 按插入线层级更新父节点（可为根级）并走阶段一重排管道（目标兄弟集合内 `sort_index`）。
  - 变子 → `HierarchyService.setParent(child, targetParent)` + 在新父子列表**末尾**追加（spec 决定 6，`sort_index = lastRank + STEP`）；同时清理原父下顺序（按需重编号，复用 `buildManualSortRankPlan`）。

### 3.4 防环与边界
- `setParent` 内 `isDescendant` 校验（2.1），拖动 `onDragOver` 即时禁用非法落点（目标是自身/后代时不显示“变子”预览、不接受 drop）。
- 折叠节点作为落点：明确“拖到折叠节点上=放入其子列表末尾”，预览需体现。
- 搜索/过滤/隐藏文件状态下退化为扁平或禁用层级拖动，避免对不可见节点误操作（spec 边界 5）。
- 非 md 文件不参与（`partitionManualSortFiles`，置末尾）。
- **Pinned notes 始终平铺置顶，不参与树展示与层级拖动**；树只作用于普通文件区（见 `folder-note-hierarchy.md` 已确认决定）。`buildListItems` 的 pinned 区分支（:336）保持现状，树组装只对 `unpinnedFiles` 进行。

### 3.5 升/降级键盘快捷键（延后）
- 在 `useListPaneKeyboard` 增 Alt+←（降级到上一个兄弟的子）/ Alt+→（提升到父的兄弟），调 `HierarchyService.setParent` + 重排。与现有 Alt+↑/↓（同级移动）并列。第一期可不做。

### 3.6 批量变子节点（延后）
- 多选拖动“变为某节点子节点”：对每个被选 md 文件 `setParent` 到目标，统一在目标子列表末尾按选中顺序排 `sort_index`，并全程防环。第一期仅单个变子；多选仅支持同级排序（复用阶段一）。

---

## 4. 风险、未决与测试策略

### 4.1 主要风险
1. **dnd-kit × 虚拟化**：见 0.3。需早做一个最小可拖原型验证自动滚动 + 落点正确，再铺开。
2. **两意图拖动判定**（3.3）：spec 反复强调的误操作风险。规则与阈值在写代码前定死，且强制放手前预览。
3. **hierarchy.json 同步**：整文件 last-write-wins；多设备并发改层级会丢一侧。单人场景可接受，但需在文档提示用户开启社区插件配置同步。
4. **退役 ManualSortListContent**：确认字数目标进度头、自定义分组头、多选等能力在虚拟列表侧均已覆盖后再删，避免功能回退。

### 4.2 未决（实现期可定的小项）
- 缩进单位像素值、变子阈值的具体数值（交互手感，原型期调）。
- `hierarchy.json` 写入 debounce 时长、version bump 合并窗口时长。
- 树模式下“未排序区”如何与层级共存（pinned 区已定稿：不参与，见 3.4）。

### 4.3 测试
- 单元：`HierarchyService`（防环、applyRename/applyDelete、getDescendants）；树构建（`listItems`）的 DFS 顺序与折叠跳过；`sort_index` 兄弟集合重排。
- 现有：`manualSort.test.ts` / `listItems.test.ts` 扩展。
- 手测：对照两个 spec 的验收标准全过；重点回归——普通点击/键盘导航/搜索/筛选不因拖动或树退化（两 spec 各自验收最后一条）。

---

## 5. 推进顺序回顾

```
阶段一  默认拖动排序（含虚拟列表加拖动、默认 compact、退役编辑模式）
  └─ 里程碑：sort_index 文件夹可直接拖、重启后保留
阶段二  层级数据层（HierarchyService + path 同步 + 树构建 + sort_index 作用域）
  └─ 里程碑：有父子关系的文件夹自动渲染为正确树（暂不可拖改层级）
阶段三  层级交互层（树渲染 + 折叠持久化 + 两意图拖动 + 防环）
  └─ 里程碑：拖动可换序/可变子，重启后层级与顺序保留
延后    升降级快捷键、批量变子节点、跨文件夹层级、多父
```

# Specs

这个目录用于记录我们想对 Notebook Navigator 做的独立改动。

每个 spec 尽量保持一件事一个文件，先描述用户体验、边界和验收标准，再进入实现。

## 当前 specs

- [默认拖动排序](default-drag-sort.md) — 待确认问题已定稿，含实现架构与思路。
- [文件夹内笔记层级](folder-note-hierarchy.md) — 待确认问题已定稿，含实现架构与思路。
- [实现计划](implementation-plan.md) — 两个 spec 统一的文件/函数级落地计划（“怎么做”）。

## 实现顺序

两个 spec 共享数据层（`src/utils/manualSort.ts`）和拖动框架（`@dnd-kit`），层级建立在拖动排序之上。详见 [实现计划](implementation-plan.md)。建议顺序：

1. 默认拖动排序（给虚拟化列表加拖动、默认 `compact`、退役显式编辑模式）。
2. 文件夹内笔记层级 · 数据层（`HierarchyService` + `hierarchy.json` 单父关系 + 路径同步 + `sort_index` 作用域收窄到兄弟集合）。
3. 文件夹内笔记层级 · 交互层（水平拖动判定两意图 + 展开折叠持久化 + 防环）。

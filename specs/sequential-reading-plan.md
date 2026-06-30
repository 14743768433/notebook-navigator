# 顺序阅读与编辑执行计划

## Summary

目标按 `specs/sequential-reading.md` 实现一个文件夹级连续 Markdown 编辑视图：

- 一个 Obsidian 自定义 tab 对应一个文件夹。
- tab 内按 Notebook Navigator 当前文件夹语义展示 Markdown 文件顺序。
- 每个 Markdown 文件是一个独立 section，section 内可编辑，保存直接写回原始文件。
- 不生成拼接文件，不保存分割线，不允许跨 section 编辑。
- 最终验收必须逐条对照 `specs/sequential-reading.md` 的 27 条验收标准，输出 Pass / Fail / 证据。

## Research Notes

调研结论：

1. Obsidian 自定义 view 是合适承载方式。官方开发文档把 view 作为显示内容的核心 UI 扩展点；本项目当前
   `node_modules/obsidian/obsidian.d.ts` 也确认
   `Plugin.registerView(...)`、`ItemView`、`WorkspaceLeaf.setViewState(...)` 是可用 API。
2. `MarkdownRenderer.render(app, markdown, el, sourcePath, component)` 的 `sourcePath`
   参数用于解析相对内部链接，适合只读 fallback 和错误降级视图。
3. `Vault.cachedRead(file)` 适合展示；但保存前必须用 `Vault.read(file)` 读取最新原文，再拼接保留的 frontmatter 后
   `Vault.modify(file, data)` 写回。
4. `MetadataCache.on('changed')` 不处理 rename，官方类型注释要求 rename 走 vault rename
   event。因此 view 自治刷新必须同时监听 vault create/delete/rename/modify 和 metadata changed/resolved。
5. Fevol / Matthew Meyers 的 `EmbeddableMarkdownEditor` gist 证明可以在任意 DOM 容器内挂 Obsidian 内部 CM6 Markdown
   editor，并通过独立 editor state 支撑每 section 一个编辑器的方案。但它依赖内部 API，必须做兼容兜底。
6. Obsidian Kanban 的 Markdown editor 源码也采用类似“嵌入 Markdown editor + mock
   controller/activeEditor”的思路，说明这种路线在成熟插件中出现过。
7. Textflow 证明“多个 note 组成一个 editable flow”是成熟需求，但它的普通 flow 采用拼接文件、UUID region
   tracking、双向同步和完整性检查，复杂度与风险较高。我们的方案不创建拼接文件、每 section 独立编辑器，可以避开大部分 region
   mapping 和跨边界编辑风险。

参考：

- Obsidian Views: https://docs.obsidian.md/Plugins/User+interface/Views
- Obsidian API types: https://github.com/obsidianmd/obsidian-api
- Embeddable CM Markdown Editor gist: https://gist.github.com/Fevol/caa478ce303e69eabede7b12b2323838
- Obsidian Kanban MarkdownEditor:
  https://github.com/mgmeyers/obsidian-kanban/blob/main/src/components/Editor/MarkdownEditor.tsx
- Textflow: https://github.com/tine-schreibt/textflow

## Decisions

这些按 spec 直接定下来，不再作为阻塞问题：

1. 折叠子节点进入顺序阅读，顺序源必须忽略左侧折叠状态，输出完整 DFS。
2. view 自治刷新，不依赖 ListPane 推送 `filePaths`。
3. ListPane 只做打开入口和普通点击拦截。
4. 每 section 一个独立内嵌 Obsidian/CM6 Markdown editor。
5. 不允许跨 section 编辑；独立 editor 实例是主要边界保障。
6. 搜索状态不支持顺序阅读。
7. 中键、新 tab、上下文菜单、键盘自动打开第一版不拦截。
8. 同一文件夹复用已有顺序阅读 tab，不同文件夹允许各自打开 tab。
9. 第一版先直接实例化当前文件夹 sections；如果实测数十篇以上明显卡顿，再启用懒挂载。
10. 内嵌编辑器原型不可用时，降级为只读 Markdown 渲染，并提供打开原文件的逃生入口；不能假装可编辑。

## Phase Plan

### Phase 0: 基线与 API Spike

目标：先证明风险最高的内嵌编辑器能在当前 Obsidian API 与本项目构建中工作。

工作：

1. 跑当前基线测试和构建，记录已有状态。
2. 在隔离文件中引入最小 `EmbeddableMarkdownEditor` 适配层，保留 MIT 署名。
3. 做一个临时/测试用容器验证：可设置初始 Markdown、可读取 `value`、`onChange` 触发、销毁不泄漏。
4. 加版本探测：拿不到内部 editor prototype 时返回不可用状态。

验收：

1. `npm run build` 通过。
2. 能明确判断编辑器可用/不可用。
3. 不可用时不会导致 view 空白或插件崩溃。

### Phase 1: 顺序来源纯函数

目标：抽出 `computeSequentialReadingOrder(...)`，不依赖 React/ListPane 可见行。

工作：

1. 复用 `getFilesForNavigationSelection` / `sortUtils` / `manualSort` / hierarchy service 语义。
2. 只处理 folder selection。
3. 只输出 Markdown。
4. pinned Markdown 放前。
5. `sort_index` 与当前文件夹排序覆盖一致。
6. 层级关系输出完整 DFS，忽略 `expandedNoteTreeNodes` 与分组折叠状态。
7. 非 Markdown、`.pg`、canvas、base 等排除。

测试：

1. pinned 在前。
2. `sort_index` 排序正确。
3. 父子层级完整 DFS。
4. 折叠节点仍进入顺序。
5. 非 Markdown 排除。

验收对应 spec：3, 4, 5, 6, 7, 25, 26。

### Phase 2: Markdown 内容切分与保存管道

目标：保证 frontmatter 隐藏但保存不丢。

工作：

1. 新增 `splitMarkdownFrontmatter(content)`。
2. 新增 `joinMarkdownFrontmatter(frontmatter, body)`。
3. 处理 BOM、CRLF、空 frontmatter、未闭合 frontmatter。
4. `saveSequentialReadingSection(filePath, bodyMarkdown)` 使用 `vault.read` 读最新原文，再 `vault.modify` 写回。
5. 写回时仅替换正文，保留原 frontmatter。
6. 写回失败时返回明确错误，供 section 显示 warning。

测试：

1. 有/无/空/未闭合 frontmatter。
2. 正文中间 `---` 不误删。
3. 空正文保存为空正文。
4. 分割线文本不会进入文件。
5. 同一次保存只写一个文件。

验收对应 spec：10, 12, 13, 14, 15, 17。

### Phase 3: 顺序阅读 View Shell

目标：先做可打开、可恢复、可渲染的自定义 view。

工作：

1. 新增 `SequentialReadingView extends ItemView`。
2. 注册 view type。
3. view state 只保存 `{ folderPath, focusPath? }`。
4. 实现 open/reuse：同文件夹复用已有 tab，不同文件夹可开多个 tab。
5. view 打开后调用 `computeSequentialReadingOrder(folderPath)` 自行计算顺序。
6. 渲染分割线与只读 Markdown fallback。
7. 空文件夹显示轻量空状态。
8. CSS 做低干扰居中分割线，不加 heading。

测试：

1. view state 可保存/恢复。
2. folderPath 无效、focusPath 删除时不抛错。
3. 分割线不进入 Markdown 内容。

验收对应 spec：1, 3, 4, 8, 9, 10, 11。

### Phase 4: 每 Section 独立编辑器

目标：把只读 section 替换为独立内嵌 Markdown editor，并完成安全保存。

工作：

1. 每个 Markdown section 创建独立 editor 实例。
2. editor 初始值为剥离 frontmatter 后的正文。
3. `onChange` debounce 保存，`onBlur` 立即 flush。
4. section 维护 clean / dirty / error 状态；正常保存中/保存成功不显示常驻文字，只在失败时提示。
5. 保存成功后更新本 section 基准内容。
6. 保存失败显示低干扰错误状态或 warning toast，保留用户输入。
7. 每个 editor 独立 undo/redo，天然隔离跨 section 操作。
8. 空笔记 section 可直接输入并写回原文件。

测试：

1. 编辑普通正文写回原文件。
2. 编辑空笔记写回原文件。
3. frontmatter 不丢。
4. 同一次编辑不能影响两个文件。
5. 销毁 view 时 editor 都 unload。

验收对应 spec：12, 13, 14, 15, 16, 17。

### Phase 5: ListPane 入口与点击定位

目标：把顺序阅读接进用户主流程，但不破坏原点击行为。

工作：

1. 在文件夹视图顶部工具区加“顺序阅读”入口。
2. 搜索状态禁用/隐藏该入口。
3. 点击调用 `plugin.openSequentialReading(folderPath, focusPath?)`。
4. 在 `useListPaneSelectionCoordinator.selectFileFromList` 的普通打开分支前注入 `revealSequentialReadingFile(...)`。
5. 仅鼠标普通点击可被拦截；中键、新 tab、上下文菜单、键盘打开不拦截。
6. 拦截成功时仍保留列表选中状态，并激活 tab、滚到分割线。
7. 顺序阅读 tab 打开时入口按钮显示 active 状态，关闭后取消；关闭后点击恢复打开单篇 Markdown。

测试：

1. tab 未打开时点击照常打开 Markdown。
2. tab 打开时点击对应 Markdown 滚动定位。
3. 搜索结果点击不拦截。
4. 非 Markdown 点击不拦截。
5. 中键/新 tab 不拦截。

验收对应 spec：1, 2, 18, 19, 20, 27。

### Phase 6: View 自治刷新

目标：tab 不依赖当前 ListPane，能持续跟随文件夹变化。

工作：

1. view 注册 vault create/delete/rename/modify。
2. view 注册 metadataCache changed/resolved。
3. view 注册 settings/storage/hierarchy 变化监听。
4. 相关事件 debounce 后重算顺序。
5. 内容修改刷新对应 section；结构变化重排 sections。
6. 自己写回触发的 modify / metadata changed 事件不能覆盖当前输入或跳光标。
7. 外部修改当前正在编辑 section 时，先标记外部变更，避免直接覆盖；失焦或用户确认后再刷新。
8. 重渲染尽量保留滚动位置；点击定位优先 `focusPath`。

测试：

1. 修改正文自动更新。
2. 新建 Markdown 自动出现。
3. 删除 Markdown 自动移除。
4. 重命名 Markdown 分割线更新。
5. sort_index 变化重排。
6. hierarchy 变化重排。
7. 当前编辑 section 不被自身保存事件重置。

验收对应 spec：21, 22, 23, 24, 25, 26。

### Phase 7: 性能与降级

目标：数十篇文件夹可用，失败路径明确。

工作：

1. 测量 10 / 30 / 60 sections 的打开耗时、滚动流畅度、保存延迟。
2. 如果直接实例化卡顿，启用 IntersectionObserver 懒挂载：
   - 未进入视口时只读渲染。
   - 进入视口时挂 editor。
   - 离开较远且 clean 时销毁 editor。
3. 内嵌 editor 不可用时，整 tab 降级只读 Markdown 渲染。
4. 降级状态提供“打开原文件”入口。

验收：

1. 数十篇文件夹打开可用。
2. 不可用路径有明确提示，不空白，不丢数据。

### Phase 8: 终验、部署与 Spec 对照

目标：交付前逐条证明是否满足 spec。

自动验证：

1. `npm test -- tests/utils/sequentialReading*.test.ts`
2. `npm test -- tests/hooks/listPaneData/listItems.test.ts`
3. `npm test -- tests/utils/manualSort.test.ts`
4. `npm run lint`
5. `npm run build`

手动验证：

1. 在真实 vault 的文件夹中准备 pinned、普通 Markdown、`.pg` 文件。
2. 准备父子层级、折叠节点、空笔记、带 YAML 的笔记、含图片/内部链接的笔记。
3. 打开顺序阅读 tab，逐项测试点击定位、编辑保存、刷新、关闭恢复。
4. 部署到 `D:\自我思考\.obsidian\plugins\notebook-navigator` 后再测一次真实 Obsidian 行为。

最终输出必须包含：

1. `specs/sequential-reading.md` 27 条验收标准逐条 Pass / Fail / 证据。
2. 自动测试命令与结果。
3. 手动验收场景与结果。
4. 已知风险与未完成项。

## Risks

1. 内嵌 editor 依赖 Obsidian 内部 API。必须有只读 fallback。
2. 多 editor 实例可能造成打开或滚动卡顿。先实测，再决定是否启用懒挂载。
3. 外部修改与当前 section 编辑并发可能覆盖输入。必须区分自写回事件和外部事件。
4. frontmatter 保存逻辑必须保守，未闭合 frontmatter 不应吞正文。
5. 点击拦截必须只影响普通点击，不能破坏多选、新 tab、搜索、键盘导航。
6. 顺序纯函数必须复用现有排序语义，否则会和左侧列表出现微妙分叉。

# 顺序阅读与编辑

## 背景

Notebook Navigator 已经可以在文件夹视图中表达一个清晰的笔记顺序：

1. pinned 笔记优先显示。
2. 普通 Markdown 笔记按当前文件夹的排序方式排列。
3. 开启文件夹内笔记层级后，父节点和子节点会以树的 DFS 顺序呈现为从上到下的列表。

现在希望在这个顺序基础上增加一个“顺序阅读与编辑”视图：把当前文件夹里的 Markdown 笔记按列表顺序连续呈现出来，像一篇临时拼成的大 Markdown，方便从上到下阅读和编辑一个文件夹或项目。

这个视图不是导出，也不保存一篇新的拼接文件。它是一个实时根据文件夹内 Markdown 文件生成的 Obsidian
tab；用户在其中编辑某一段内容时，改动直接写回该段对应的原始 Markdown 文件。

## 目标体验

用户在文件夹视图中点击“顺序阅读”入口后：

1. Obsidian 新开一个 tab，显示当前文件夹的顺序阅读视图。
2. 视图按 Notebook Navigator 当前文件夹顺序拼接 Markdown 内容。
3. 只包含 Markdown 文件，不包含 `.pg` 等非 Markdown 文件。
4. 每篇笔记之间使用淡色分割线，分割线中间显示笔记名称。
5. 不额外插入标题层级，不把文件名写成 `#` / `##` 标题。
6. 每篇笔记正文不显示 YAML frontmatter。
7. 空笔记不显示占位文字，只保留分割线。
8. 用户可以直接编辑某篇笔记的正文内容，保存后写回原始 Markdown 文件。
9. 分割线和文件名只是边界提示，不是正文，不参与保存。
10. 顺序阅读 tab 打开期间，在对应文件夹的 Notebook
    Navigator 列表里点击某篇笔记，会跳转到顺序阅读 tab 中该笔记对应的位置。
11. 顺序阅读 tab 未打开时，点击列表笔记仍保持原行为：打开对应 Markdown 文件。
12. 视图实时刷新：笔记内容、文件名、创建/删除、排序、层级、pinned 状态变化后，顺序阅读视图自动更新。

## 非目标

第一版不做：

1. 不保存拼接后的 Markdown 文件。
2. 不做项目导出。
3. 不做搜索结果的顺序阅读。
4. 不把非 Markdown 文件渲染进阅读视图。
5. 不把分割线或文件名保存进原笔记。
6. 不在第一版中直接编辑 YAML frontmatter；frontmatter 保留在原文件里，但在连续视图中隐藏。
7. 不新增标题层级或自动重写标题。
8. 不做跨文件夹拼接。
9. 不把顺序阅读作为默认打开方式；只有用户显式打开顺序阅读 tab 后，列表点击才改为定位。
10. 不允许跨 section 编辑。任何一次输入、删除、剪切、粘贴、格式化、撤销/重做都只能作用于单个 section，不能跨过分割线影响另一个 Markdown 文件。

## 入口与 tab 行为

### 打开入口

顺序阅读入口应放在文件夹列表的顶部工具区，语义类似“阅读当前文件夹”。

要求：

1. 只有当前选择目标是文件夹时可用。
2. 搜索状态下不可用，因为顺序阅读只处理文件夹，不处理搜索结果。
3. 点击后新开一个 Obsidian tab。
4. 如果当前文件夹已经有顺序阅读 tab 打开，再次点击应复用并激活已有 tab，而不是无限新建重复 tab。
5. 不改变当前文件夹的排序方式，也不自动开启 `sort_index`。

建议：

1. tab 标题使用 `顺序阅读: 文件夹名`。
2. tab icon 使用阅读、书本或文档组合类图标。
3. 一个文件夹最多维护一个顺序阅读 tab；不同文件夹可以各自有自己的顺序阅读 tab。

### tab 生命周期

顺序阅读 tab 是 Obsidian 自定义 view，并且正文区域需要可编辑。

要求：

1. tab 打开后持续占用一个 workspace leaf。
2. 用户关闭 tab 后，Notebook Navigator 列表点击恢复为正常打开 Markdown。
3. Obsidian workspace 恢复时，如果顺序阅读 tab 被恢复，应重新根据当前文件夹状态渲染，而不是依赖旧 HTML。
4. 用户在 tab 中编辑正文时，保存目标必须是对应 section 的原始 Markdown 文件，而不是顺序阅读 view 自己的临时状态。

## 顺序来源

顺序阅读必须复用 Notebook Navigator 的当前文件夹顺序语义，不能另写一套独立排序。

顺序规则：

1. pinned Markdown 笔记在最前面。
2. 普通 Markdown 笔记按当前文件夹排序方式排列。
3. 如果文件夹使用 `sort_index`，使用 `sort_index` 排序结果。
4. 如果启用了文件夹内笔记层级，父子关系按列表中的上下顺序展开。
5. 非 Markdown 文件不参与顺序阅读，也不显示分割线。
6. 搜索结果不参与顺序阅读。

### 折叠子节点（已定：进入）

折叠的层级子节点、折叠分组里的笔记**仍然进入顺序阅读**。

- 理由：顺序阅读的目标是“当前文件夹所有 Markdown 内容从上到下阅读”，折叠只是左侧导航的显示状态，不应该导致正文缺失。
- 实现约束：**不能直接复用 `buildOrderedFiles(listItems)`**。`buildListItems` 的 `visit()`
  在节点折叠时会提前返回、不 push 子节点（折叠分组同理），所以 `listItems`
  只包含“当前可见行”。顺序阅读必须用一份**忽略折叠状态（`expandedNoteTreeNodes` / 分组折叠）的完整 DFS**
  顺序，复用相同的排序/层级语义，但展开全部节点。
- 这份完整顺序应抽成一个**对任意 `folderPath`
  可调用的纯函数**（见「建议架构 → 顺序来源纯函数」），而不是绑定在某个具体 ListPane 实例的可见状态上。

## 渲染与编辑规则

### 分割线

每篇笔记前显示一个淡色分割线：

```text
-------------------- 笔记名 --------------------
```

视觉要求：

1. 线条轻、淡、低干扰。
2. 文件名居中显示，颜色使用 faint/muted 文本色。
3. 分割线不应像按钮、卡片或标题。
4. 分割线本身作为该笔记的滚动锚点。
5. 文件名显示使用 Notebook Navigator 的文件显示名；完整路径可放在 tooltip 或 aria label。

### Markdown 正文

正文渲染要求：

1. 使用 Obsidian 的 Markdown 渲染能力，尽量保证内部链接、图片、嵌入、代码块、列表等表现可用。
2. 每篇笔记应以自身路径作为 Markdown source path 渲染，避免相对链接和图片路径解析错误。
3. 不显示 YAML frontmatter。
4. YAML 剥离只处理文件开头的标准 frontmatter：

```markdown
---
key: value
---

正文
```

5. 如果剥离 frontmatter 后正文为空，不显示“空笔记”“写点什么”等占位文字。
6. 不自动把文件名转成 Markdown 标题。

正文编辑要求：

1. 每篇笔记正文是一个独立编辑区域。
2. 用户在某个编辑区域内修改内容时，只写回该编辑区域对应的原始 Markdown 文件。
3. 保存时必须保留原文件已有 YAML frontmatter；连续视图隐藏 frontmatter，但不能因为用户编辑正文而丢失 frontmatter。
4. 分割线、文件名、文件边界不进入编辑区域，不会被保存到 Markdown 文件。
5. 空笔记的编辑区域可以为空；用户点入后输入内容，应直接写入该空笔记正文。
6. 不允许跨 section 选择、删除、剪切、粘贴、拖拽文本、格式化或撤销/重做。编辑边界必须被写死在单个 section 内，避免误把多个文件合并或破坏边界。
7. 编辑保存失败时，该 section 应显示低干扰错误状态或 warning toast，不能静默丢失用户输入。
8. 如果一次用户操作试图跨越 section 边界，系统应阻止该操作，或把操作裁剪到当前 section 内；不能让分割线两侧的两个文件同时被同一次编辑修改。

### 空状态

如果当前文件夹没有任何 Markdown 文件：

1. 显示一个轻量空状态，例如“当前文件夹没有 Markdown 笔记”。
2. 不显示搜索入口。
3. 不创建任何文件。

## 点击与跳转行为

### 顺序阅读 tab 未打开

Notebook Navigator 列表点击行为完全保持现状：

1. 普通点击打开 Markdown。
2. 多选、范围选择、新 tab 打开等现有行为不退化。

### 顺序阅读 tab 已打开

当对应文件夹的顺序阅读 tab 已打开，并且当前 Notebook Navigator 处于同一个文件夹视图、非搜索状态时：

1. 普通点击某个 Markdown 笔记，不再打开单篇 Markdown。
2. 列表仍更新选中状态。
3. 顺序阅读 tab 被激活。
4. 顺序阅读 tab 滚动到该笔记的分割线位置。
5. 如果该笔记已被删除或不在当前顺序阅读文件列表里，回退到正常打开行为或给出低干扰提示。

不拦截：

1. 搜索结果中的点击。
2. 非对应文件夹中的点击。
3. 非 Markdown 文件点击。
4. 中键、显式新 tab 打开、上下文菜单打开等高级打开动作，除非后续明确要求统一拦截。

需要确认的边界：

1. 键盘上下移动选中时，是否也要同步滚动顺序阅读。
   - 建议第一版只处理鼠标普通点击，避免键盘浏览时频繁抢占焦点。
2. 如果顺序阅读 tab 打开但不在当前可见 split，点击后是否强制激活该 tab。
   - 建议激活，因为用户此时明确是在使用顺序阅读定位。

## 实时刷新

顺序阅读视图必须是 live editable view。

刷新模型采用 **view 自治**：tab 在打开时绑定到一个
`folderPath`，之后**由 view 自己负责刷新自己**，而不是依赖 ListPane 在用户停留于该文件夹时推送。

- view 自己监听 `app.vault`（create/delete/rename/modify）、`app.metadataCache`（changed/resolved）以及 Notebook
  Navigator 的 settings/storage 变化。
- 任一相关事件触发后，view 调用「顺序来源纯函数」对自己的 `folderPath` 重新计算完整顺序并刷新。
- 这样即使用户在导航里切到了别的文件夹、或 workspace 重启恢复（导航面板未挂载），该 tab 仍能保持正确，不会断流。

需要响应：

1. 当前文件夹内 Markdown 内容修改。
2. 当前文件夹内 Markdown 新建。
3. 当前文件夹内 Markdown 删除。
4. 当前文件夹内 Markdown 重命名。
5. 当前文件夹排序变化。
6. pinned 状态变化。
7. 文件夹内笔记层级变化。
8. frontmatter 改动导致正文或排序变化。

刷新策略：

1. 内容修改可以 debounce，避免用户输入时频繁完整重渲染。
2. 排序、层级、pinned 变化后应尽快更新顺序。
3. 重渲染时尽量保留当前滚动位置；如果刷新由点击定位触发，则优先滚到目标笔记。
4. 渲染失败不应让整个 tab 空白；单篇失败时可以显示轻量错误块并继续渲染其他笔记。
5. 正在编辑的 section 不应因为外部刷新导致光标跳动或输入被覆盖；同一文件发生外部修改时，需要有明确策略，例如延迟刷新、合并最新内容，或提示用户该 section 有外部变化。

## 建议架构

整体采用 **view 自治**
数据流：顺序的计算与刷新都收敛在 view + 一个共享纯函数里，ListPane 只保留“打开入口”和“点击拦截”两个钩子，不再推送顺序。

### 顺序来源纯函数

把当前散落在 ListPane / `buildListItems` 里的排序与层级语义，抽出一个**对任意 `folderPath`
可调用、不依赖任何 React/ListPane 可见状态**的纯函数，例如：

```ts
computeSequentialReadingOrder(deps, folderPath): TFile[]
// deps: app、settings、storage（pinned、sort_index、层级关系 hierarchyParentByPath 等）
```

要求：

1. 复用与文件夹列表一致的排序语义：pinned 优先、当前文件夹排序方式 / `sort_index`、层级父子关系。
2. **展开全部层级与分组（忽略折叠状态）**，输出完整 DFS 顺序。
3. 只输出 Markdown 文件，排除 `.pg`、canvas、base 等非 Markdown 文件。
4. view 和 ListPane 拦截判断都调用同一个函数，保证顺序一致、不出现两套排序。

### View 层

新增 `SequentialReadingView`：

1. 继承 Obsidian `ItemView`。
2. view type 例如 `notebook-navigator-sequential-reading`。
3. view state 只保存定位所需的最小信息：

```ts
{
  folderPath: string;
  focusPath?: string;
}
```

4. **不在 state 里保存
   `filePaths`**。文件顺序由 view 调用「顺序来源纯函数」自行计算，保证 workspace 恢复时也能基于当前文件夹状态重算，而不是依赖旧的推送结果。
5. view 自己监听 vault / metadataCache / settings 事件并按需重算（见「实时刷新」）。
6. 每个文件 section 维护自己的编辑状态、保存状态和外部刷新状态。
7. 写回文件时，应把隐藏的 frontmatter 与用户编辑后的正文重新组合后保存。

### 编辑承载：每 section 一个内嵌编辑器（已定）

每个文件 section 的正文用**一个独立的内嵌 Obsidian 编辑器实例**承载，方案采用社区成熟的 `EmbeddableMarkdownEditor`
模式（Fevol / Matthew Meyers 的 MIT gist，Kanban 等插件在用）。

为什么选它：

1. 它通过 `app.embedRegistry` 临时实例化 widget editor 来解析出 Obsidian 内部的 `ScrollableMarkdownEditor`
   原型，从而在**任意 DOM 容器**里挂一个与原生编辑器一致的 CodeMirror 6 实例——支持 Live
   Preview、内部链接、图片/嵌入、命令、（可选）vim，不需要绑定到具体 leaf。
2. **天然满足“禁止跨 section 编辑”**：每个 section 是独立的 CM6 实例，拥有独立的 editor
   state 和独立的 undo/redo 历史。选择、剪切、粘贴、格式化、撤销/重做物理上无法越过分割线影响相邻文件——不需要再手写边界裁剪逻辑。
3. 与“正文不含 frontmatter”一致：编辑器里只放剥离 frontmatter 后的正文；保存时把原文件的 frontmatter 与编辑器当前正文重新拼接写回。

构造与生命周期（来自 gist API）：

```ts
new EmbeddableMarkdownEditor(app, containerEl, {
  value, // 初始正文（已剥 frontmatter）
  placeholder,
  cls,
  onChange, // debounce 后触发保存
  onBlur, // 失焦立即保存
  onEnter,
  onEscape,
  onPaste
});
// 取值：editor.value   设值：editor.set(content)
// 卸载：view.addChild(editor) 交给 view 自动销毁，或手动 editor.destroy()
```

注意点 / 风险（写进风险登记）：

1. **非官方 API**：依赖内部原型解析（`resolveEditorPrototype()` /
   `embedRegistry`）。需要做版本探测与兜底——拿不到原型时退化为只读 `MarkdownRenderer.render` +
   “在默认编辑器打开”提示，而不是整篇空白。
2. Obsidian 1.5.8+ 需要 `this.set(options.value || '')` 才能正确初始化（gist 已处理）。
3. 其他插件的 CM 编辑器扩展**不会**自动注入该实例；如需特定扩展要在 `buildLocalExtensions()` 里手动加。
4. 每个实例构造约 5ms。几十篇可接受；大文件夹需**懒挂载**：section 滚入视口前先用只读渲染占位，滚入后再实例化编辑器，滚出后可销毁编辑器、回退只读，控制同时存活的实例数。
5. 引入 gist 代码需保留 Matthew Meyers 与 Fevol 的 MIT 署名。

保存流程：

1. `onChange` 经 debounce、或 `onBlur` 立即，调用 `saveSequentialReadingSection(filePath, editor.value)`。
2. 该方法读取原文件 → 用同一套 `stripYamlFrontmatter` 逻辑取出 frontmatter 块 → `frontmatter + 编辑后正文`
   重新组合 → 写回。
3. 写回触发的 `vault.modify` 事件，对“正在编辑的 section”要跳过外部刷新（避免覆盖光标/输入），见「实时刷新」第 5 条。
4. 写回触发的 `metadataCache.changed`
   也必须按本地保存来源跳过；正常保存成功/保存中不显示常驻文字，只在保存失败时显示低干扰错误状态或 warning toast。

### Plugin 协调层

在 plugin 上提供最小方法：

1. `openSequentialReading(folderPath, focusPath?)` —— 找到或创建该文件夹的 tab 并激活；不传
   `filePaths`，顺序由 view 自算。
2. `revealSequentialReadingFile(folderPath, filePath): boolean` —— 若该文件夹有打开的 tab 且 `filePath`
   在其当前顺序内，则激活 tab 并滚到对应 section，返回 `true`；否则返回 `false`。
3. `isSequentialReadingOpenForFolder(folderPath): boolean`
4. `closeSequentialReading(folderPath): boolean` —— 关闭该文件夹当前打开的顺序阅读 tab。
5. `saveSequentialReadingSection(filePath, bodyMarkdown)`
   —— 把某个 section 的编辑内容安全写回对应原文件（保留 frontmatter）。

这些方法负责：

1. 找到或创建对应文件夹的顺序阅读 tab。
2. 在列表点击时判断是否应该拦截打开并改为滚动定位。
3. 把某个 section 的编辑内容安全写回对应原文件。

> 不再需要 `updateSequentialReading(folderPath, filePaths)`：顺序刷新是 view 自治的，外部无需推送。

### ListPane 协调

ListPane 只保留两件事：

1. 在文件夹视图提供顺序阅读入口：未打开时点击调用
   `openSequentialReading(folderPath)`；当前文件夹顺序阅读已打开时按钮高亮，再次点击调用
   `closeSequentialReading(folderPath)` 关闭该 tab。
2. 普通点击 Markdown 文件时，先调用 `revealSequentialReadingFile(folderPath, filePath)`：
   - 注入点为 `selectFileFromList`（`useListPaneSelectionCoordinator.ts`）中 `openFileInWorkspace(file)` 之前；此时已
     `dispatch SET_SELECTED_FILE`，因此“列表仍更新选中状态”天然满足。
   - **拦截口径以“被点文件是否在该 tab 的当前顺序列表内”为准**（`revealSequentialReadingFile` 返回
     `true`），而不是比较文件夹路径是否相等；这样对后代文件、虚拟文件夹等情况更鲁棒。
   - 返回 `true` 则不再打开单篇 Markdown；返回 `false` 则照常打开。
   - 只拦截鼠标普通点击；keyboard debounce-open、enter-to-open、显式新 tab、中键、上下文菜单等分支第一版不拦截。

ListPane **不再生成或推送 `filePaths`**——顺序计算完全交给「顺序来源纯函数」+ view。

## 验收标准

1. 在文件夹视图点击顺序阅读入口，会新开一个 Obsidian tab。
2. 搜索状态下不能打开搜索结果的顺序阅读。
3. 顺序阅读只显示当前文件夹内的 Markdown 文件。
4. `.pg` 等非 Markdown 文件不会出现在顺序阅读中。
5. pinned Markdown 笔记显示在最前面。
6. 普通 Markdown 笔记顺序与 Notebook Navigator 当前文件夹顺序一致。
7. 父子层级笔记在顺序阅读中按列表上下顺序连续出现。
8. 每篇笔记前有淡色居中名称分割线。
9. 分割线不会创建 Markdown 标题层级。
10. YAML frontmatter 不显示。
11. 空笔记只显示分割线，不显示占位正文。
12. 用户在某篇笔记 section 中编辑正文后，原始 Markdown 文件内容同步更新。
13. 用户编辑正文时，原始 Markdown 文件的 YAML frontmatter 不会丢失。
14. 分割线和文件名不会被写入原始 Markdown 文件。
15. 空笔记 section 中输入内容后，内容会写入该空笔记。
16. 用户不能跨 section 选择、删除、剪切、粘贴、格式化或撤销/重做。
17. 同一次编辑操作不能同时修改两个 Markdown 文件。
18. 顺序阅读 tab 未打开时，点击列表笔记仍正常打开 Markdown。
19. 顺序阅读 tab 已打开时，点击对应文件夹内的 Markdown 笔记会激活顺序阅读 tab 并滚到对应位置。
20. 点击搜索结果不会被顺序阅读拦截。
21. 修改某篇 Markdown 内容后，顺序阅读 tab 自动更新。
22. 新建 Markdown 后，顺序阅读 tab 自动出现该笔记，位置符合当前排序规则。
23. 删除 Markdown 后，顺序阅读 tab 自动移除该 section。
24. 重命名 Markdown 后，分割线名称自动更新，点击定位仍可用。
25. 调整 sort_index 顺序后，顺序阅读 tab 顺序自动更新。
26. 调整父子层级后，顺序阅读 tab 顺序自动更新。
27. 关闭顺序阅读 tab 后，列表点击恢复为打开单篇 Markdown。
28. 编辑 section 时不显示“保存中/已保存”等正常保存状态文字；保存失败时仍有低干扰错误提示。
29. 当前文件夹的顺序阅读 tab 打开时，顺序阅读入口按钮显示 active/highlight 状态；再次点击该入口会关闭当前顺序阅读 tab，关闭后 active 状态消失。

## 测试建议

### 单元测试

1. `stripYamlFrontmatter`：
   - 有 frontmatter。
   - 无 frontmatter。
   - 空 frontmatter。
   - 正文中间出现 `---` 不应被误删。
   - CRLF 换行、文件前导 BOM。
   - **未闭合的 frontmatter**（只有开头 `---` 没有结束）不应把整篇正文当 frontmatter 吞掉。
2. 顺序阅读文件过滤：
   - 只保留 Markdown。
   - pinned 在前。
   - 非 Markdown 排除。
3. section 保存：
   - 正文写回对应文件。
   - frontmatter 保留。
   - 空正文保存为空正文。
   - 分割线文本不进入文件。
   - 同一次编辑不能写入多个文件。
4. `computeSequentialReadingOrder`：
   - pinned 在前、`sort_index` / 排序方式正确。
   - 折叠的层级子节点与折叠分组里的笔记仍然出现在完整 DFS 顺序中。
   - 非 Markdown 文件被排除。
5. view state：
   - folderPath 可恢复，恢复后基于当前文件夹状态重算顺序。
   - focusPath 指向已删除/不在顺序内的文件时不会抛错。

### 手动验收

1. 一个包含 pinned、普通 Markdown、`.pg` 文件的文件夹。
2. 一个包含父子层级的文件夹。
3. 一个有空 Markdown 的文件夹。
4. 一个带 YAML frontmatter、图片、内部链接的 Markdown。
5. 在顺序阅读 tab 内编辑普通笔记和空笔记，确认内容写回原文件。
6. 顺序阅读打开和关闭后的列表点击行为。
7. 修改正文、新建文件、删除文件、重命名文件、拖动排序、修改层级后的自动刷新。

## 已定决策

1. **折叠子节点进入顺序阅读**，用忽略折叠状态的完整 DFS（不直接复用 `buildOrderedFiles`）。
2. **顺序计算 + 实时刷新采用 view 自治**：tab 绑定到打开时选中的文件夹，view 自己监听事件并调用「顺序来源纯函数」重算，不依赖 ListPane 推送。
3. **点击拦截口径**：以“被点文件是否在该 tab 当前顺序内”为准，而非文件夹路径相等。
4. **单篇渲染/保存失败**：显示轻量错误块或 warning，继续渲染其余 section，不丢用户输入。
5. **第一版刷新粒度**：全量 debounce 重渲染、尽量保留滚动位置，不做 section 级增量；目标规模数十篇。
6. **编辑承载**：每个 section 用一个独立的 `EmbeddableMarkdownEditor`（内嵌 Obsidian CM6 编辑器）实例，复用原生 Live
   Preview，不手写编辑器；跨 section 编辑由“每 section 独立实例”天然隔离。详见「建议架构 → 编辑承载」。

## 待讨论问题

1. 键盘上下选择文件时是否同步滚动顺序阅读。建议第一版不做。
2. 中键/新 tab 打开是否也要在顺序阅读打开时改成定位。建议第一版不拦截。
3. 多个文件夹的顺序阅读 tab 是否允许同时存在。建议允许，但同一文件夹复用已有 tab。
4. 编辑器实例的挂载策略：第一版是全部 section 直接实例化，还是从一开始就做滚入视口才实例化的懒挂载。建议小文件夹直接实例化，预留懒挂载开关，待实测数十篇以上卡顿再开。
5. `EmbeddableMarkdownEditor`
   依赖内部 API 的版本兼容兜底如何做：是只在拿不到原型时退化只读，还是同时提供“在默认编辑器打开本 section”的逃生入口。

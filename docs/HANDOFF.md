# PocketCode 交接文档（S4ef → 下一个对话）

**交接时间**：2026-10-25（S4e Git Diff + S4f 多文件分享）  
**交接人**：主集成对话（S0→S4ef 全程）  
**给新对话的第一句话**：请先完整阅读本文档与 docs/ 下三份原始文档（PRD、ARCHITECTURE、DEV_PLAN），
再读 docs/decisions/ 的 4 个 ADR，然后从「待办清单」里按顺序继续。不要跳过文档直接写代码。

---

## 1. 项目现状（一句话）

S0～S3 全部真机验收通过。**S4 全部功能代码完成**（S4a 编辑器/阅读位置/草稿箱/
全屏；S4b 搜索；S4c 大纲/符号导航；S4d Python 诊断；S4e Git Diff；
S4f 多文件分享），合同现 **21 端点**，均待真机验收（桌面端需重启一次）。
S4 智能关联按 PRD 归 S5。剩余：S5 高阶 + 挂账小项（见 §4）。

## 2. 阶段状态表（真机验收口径）

| 阶段 | 状态 | 说明 |
|---|---|---|
| S0 骨架 | ✅ 真机验收通过 | monorepo、合同、Windows 骨架、APK 空壳 |
| S1 热点连通 | ✅ 真机验收通过 | App 手动地址诊断、在线/离线、自动恢复 |
| S2 配对+只读 | ✅ 真机验收通过 | 扫码配对、HTTPS 指纹校验、真实目录浏览、离线缓存 |
| S3 可日用编辑 | ✅ 真机验收通过 | 编辑/草稿/冲突/离线保存 ✓；S3c 新建/删除/回收区/快照恢复 ✓ |
| S4 体验增强 | 🔶 全部功能完成（S4a～S4ef），待真机验收 | 编辑器/阅读位置/草稿箱/全屏（S4a）；搜索（S4b）；大纲/符号导航（S4c）；Python 诊断波浪线（S4d）；Git Diff（S4e）；多文件分享（S4f）；智能关联在 S5 |
| S5 高阶 | ⬜ 未开始 | 智能关联/补丁导入/条件具备才做 ChatGPT 直连 |

**用户已确认的验收结论**（S3 测试卡，2026-10-25）：
- ✅ 编辑→关 App 重开→草稿还在；断网编辑→草稿保留→联网补保存
- ✅ 草稿多份命名、切换（修复竞态后用户确认"可以了"）
- ✅ 编辑框全屏（build 2026-10-25-4 内联样式方案）
- ✅ 目录默认收起、可展开收起、返回后展开状态保持
- ✅ Android 返回键逐级返回；撤销授权手机立即失效
- ❌ 滚动位置记忆（未解决，用户同意挂起）

## 3. 工程与环境速查（本机，Windows 11）

| 项 | 值 |
|---|---|
| 仓库 | `D:\code\PocketCode`（git 已 init，**尚无任何 commit**——建议新对话尽早做首次提交） |
| 桌面 venv | `D:\code\PocketCode\.venv`（Python 3.13.2，PySide6/FastAPI/cryptography/qrcode 已装） |
| 桌面测试 | `.venv\Scripts\python.exe -m pytest desktop/tests`（116 通过+1 跳过，跳过=符号链接需开发者模式） |
| 合同校验 | `.venv\Scripts\python.exe integration-tests/contract/check_contracts.py`（23 项；会同时核对后端路由⊆合同） |
| 移动端 | `mobile/`：`npm run typecheck && npm test && npm run build && npx cap sync android` |
| APK 构建 | `scripts/build-apk.ps1`（或 mobile/android 下 `gradle assembleDebug`，SDK 在 `%LOCALAPPDATA%\Android\Sdk`，JDK 21，系统 Gradle 8.13） |
| 产物 | `mobile\android\app\build\outputs\apk\debug\app-debug.apk`（约 27-28MB，含 ML Kit 模型） |
| 桌面启动 | `scripts\start-desktop.ps1`（HTTPS 0.0.0.0:8765，自签证书在 `%APPDATA%\PocketCode\tls`） |
| 手机 | OPPO Find X8（安卓 16），热点网段实测 `10.59.163.x`（**不要假设 192.168.43.x**） |
| 防火墙 | 已重新开启；已加放行规则 `PocketCode Server`（TCP 8765 入站） |
| 注意 | 用户电脑常开代理（TUN 虚拟网卡 vgate0）——**桌面端回环测试必须 `trust_env=False`**（pytest 里已处理，新写的 httpx 测试记得加） |

## 4. 待办清单（建议顺序）

### S4a～S4ef 真机验收（代码已完成，2026-10-25）
1. **用户按 S4 测试卡（docs/S4_测试卡.md）1-50 步验收**：S4a（1-11）、S4a2/a3
   （12-23）、S4b 搜索（24-29）、S4c/S4d 大纲与诊断（30-40）、
   S4e/S4f Git 与分享（41-50）；
2. **桌面端需重启一次**（search/diagnose/git-status/git-diff 四个新端点）；
3. APK：`mobile\android\app\build\outputs\apk\debug\app-debug.apk`
   （S4ef · build 2026-10-25-11，versionName 1.0-s4ef1；**新增
   @capacitor/share 原生插件，必须覆盖安装这个包**才有系统分享面板）。

### S4b～S4f 合同改动记录（本阶段已同步的文件，作为后续改动范例）
- `contracts/openapi.yaml`：S4b `GET /projects/{id}/search`；S4d
  `POST /projects/{id}/diagnose`；S4e `GET /projects/{id}/git/status` +
  `GET /projects/{id}/git/diff`（**合同现 21 端点 / 14 路径**）；全部只读
  语义（diagnose 虽为 POST 但不写盘），无需 ADR；
- fixtures：search_ok / diagnose_ok / git_status_ok / git_diff_ok + index 条目；
- 后端：`services/search.py`（限额 3000 文件/20 每文件/200 总数/1MiB；NUL
  二进制启发；符号链接跳过）、`services/diagnostics.py`（ast 语法 + pyflakes
  可选，未装则如实降级 analyzer="ast"；不读盘不写盘）、
  `services/gitinfo.py`（subprocess 只读 git，argv 列表无 shell；不是仓库 →
  available=false；diff 上限 256KiB）、`server/routes/projects.py` 四条新
  路由、`server/schemas.py` 新模型；**pyproject 新增 pyflakes>=3.2**；
- 测试：test_search_api.py（6）、test_diagnostics_api.py（8）、
  test_git_api.py（6，本机无 git 自动整文件跳过）；
- 手机端：types（Search*/Diagnose*/Git*）、client 四个新方法、
  `storage/cachedSearch.ts`（离线搜缓存）、`features/search/SearchScreen.tsx`、
  `features/editor/outline.ts`（大纲/定义/引用/取词纯函数）、
  CodeEditor（scrollRequest 跳行 + contextmenu 长按取词 + 诊断波浪线
  StateField + 只读选区回调）、`features/git/GitScreen.tsx`（彩色 Diff +
  复制/分享）、`features/sharing/{share.ts,bundle.ts,ShareScreen.tsx}`、
  FileScreen（大纲抽屉/符号操作单/诊断列表/返回原位置/分享片段·文件·草稿）、
  ExplorerScreen（文件名过滤 + 搜索/Git/分享入口）、App 路由
  （search/git/share 屏 + viewer.line）。

### S4 收尾挂账（功能已齐，以下为小项）
- 桌面端回收区清空确认界面（DELETE /v1/trash 无 UI）、字号设置、
  草稿导出/备份、并排 Diff 视图、草稿与电脑版比对入口、跨文件符号跳转（S5）；
- S5（PRD M3）：智能关联（分享五模式中的最后一项）、补丁导入、
  条件具备才做 ChatGPT 直连。

### S4a2 用户反馈落地的策略变化（重要，后续勿回退）
- **保存到电脑成功 → 不再清空草稿**：把活动草稿更新为刚保存的内容与
  新 baseVersion（继续编辑不假冲突），其余草稿原样保留；
- **阅读页「刷新电脑版本」→ 完全不动草稿**（reloadFromPc 与
  discardAndReload 拆分）；
- **冲突「放弃修改」→ 只删活动草稿**，其余命名草稿保留；
- 草稿定位（用户原话）：「不仅是方便改代码，还是记录修改版本和灵感的
  地方」——删除必须用户手动做（草稿箱内）。

### 合同改动提醒（S4b 起）
任何新端点必须同步：contracts/openapi.yaml + errors.md（如需新错误码）+
fixtures + 后端路由/测试 + mobile types/client/测试 + check_contracts.py，
并考虑是否需要 ADR（新增只读端点预计不需要，写操作端点必须）。

### 实现落点（S4a/S4a2/S4b/S4cd/S4ef，供后续维护）
- 编辑器：`mobile/src/features/editor/CodeEditor.tsx`（CM6 封装：
  compartment 动态切 只读/折行/语言；doc 受控同步；滚动容器=组件内部
  scroller；`scrollToLine` 支持搜索定位）；
- 阅读位置：`mobile/src/storage/readPositionStore.ts`（pc.readpos.*，
  500ms 节流写盘）；折行偏好：`storage/uiPrefs.ts`（pc.ui.wrap）；
- **搜索（S4b）**：`features/search/SearchScreen.tsx`（结果模块级保留防
  返回丢失）；离线走 `storage/cachedSearch.ts`（枚举 pc.cache.file.*）；
  ExplorerScreen 顶部文件名过滤输入框（filterTree 本地过滤、命中目录
  自动展开）；App 路由 search 屏、viewer.line；
- **草稿箱**：`features/drafts/DraftsScreen.tsx`（查看/去编辑/删除/清空全部）；
  跨文件枚举靠原生新增 `dataKeys(prefix)`（Kotlin 插件 + KVStorage.keys，
  浏览器退化为 localStorage 枚举）；listAllDrafts/clearAllDrafts 在 draftStore；
- **底部导航**：App.tsx 的 homeTab（projects/drafts），仅 atHome 时渲染，
  进项目/文件即消失（用户要求）；Android 返回键在草稿箱 → 回项目页；
- **全屏模式（S4a3 口径）**：文件页 `immersive` 默认 **true**，阅读/编辑共用、
  贯穿模式切换；App 经 onImmersiveChange 隐藏 statusbar 与页边距。
  阅读=点屏呼出菜单；编辑=顶栏常驻（✓完成/草稿select/短状态/⋯扩展行/保存/⤡），
  编辑器 flex 占满（.immersive-edit + .cmhost--editfull）。用户原则：
  「方便和功能优先，不要死守旧 UI，该重构就重构」；
- **草稿保留策略（S4a2，用户明确要求，勿回退）**：保存成功只更新活动草稿的
  内容与 baseVersion；阅读页刷新完全不动草稿；冲突「放弃修改」只删活动草稿；
  删除一律用户手动（草稿箱/编辑页）。
- 高亮配色：theme.css 的 --tok-* 变量（深浅两套）+ CodeEditor 内
  HighlightStyle 类映射（.tok-*）；
- 旧的 .codeview/.editarea CSS 与 window 级 scrollMemory（Explorer/Project
  页还在用）保留；FileScreen 已不再引用 scrollMemory。

### 未解决问题（用户同意挂起，接手后可重启调查）
见 §5 滚动记忆（**仅剩目录页部分**；文件内阅读位置已由 S4a 的
readPositionStore 按"跨重启持久化"口径实现并待验收）。

## 5. 未解决问题：目录页滚动位置记忆（PRD §4.2/§4.3 的目录部分）

**症状**：从文件返回目录（或项目→目录往返）后，列表回到顶部、需要重新滑到
上次看的文件。（文件内的阅读位置已由 S4a 的 readPositionStore 解决——
CodeMirror 内部滚动容器 + 原生磁盘 KV，与 window 滚动无关。）

**已实现但无效的方案**（build 2026-10-25-4，用户真机确认仍无效）：
- `src/app/scrollMemory.ts`：按 key（`explorer:<projectId>` / `projects`）
  记录位置；保存=window scroll 事件持续记录+卸载兜底；
  恢复=`document.scrollingElement.scrollTop = y` + `window.scrollTo` + 3 次
  rAF/60ms 重试；ExplorerScreen 在 rootChildren 就绪后恢复一次（ref 防重入）。
- 文件夹展开状态记忆（`expandedMemory` Map）是**有效的**（用户确认返回后展开
  状态保持）——说明组件重挂载路径与记忆 Map 本身没问题。

**已排除**：CSS 未打包（APK 解包核实 .editarea/完整 CSS 在内）；JS 未更新
（同包内"目录默认收起"生效）；存储未落盘（草稿/缓存已迁原生文件 KV 且工作正常）。

**下一步调查建议（按优先级）**：
1. **确认真正的滚动容器**：在真机上加临时日志（或 onScroll 打点）比较
   `window.scrollY`、`document.scrollingElement.scrollTop`、`.app`/`.screen` 的
   `scrollTop` ——若都不是，滚动可能发生在 Capacitor WebView 的原生层或某个
   未预料容器；ColorOS WebView 行为可能与标准 Chromium 不同；
2. **怀疑恢复后被再次归零**：ExplorerScreen 恢复后，网络 manifest 刷新到达会
   再 setRootChildren 触发重渲染（fromCache 提示行消失会使内容上移一行）；
   可实验：恢复改为"每次渲染后都校正直到用户交互"，或给提示行保留固定占位；
3. 备选兜底方案：记录"最后打开的文件路径+目录展开状态"代替精确像素位置，
   返回后高亮并滚到该文件元素（`element.scrollIntoView`）——对用户价值等价；
   也可参照 S4a 思路把目录页改成固定高度内部滚动容器；
4. 若像素级恢复确认不可行，PRD §4.2 的目录"滚动位置记忆"可按方案 3 的形式
   验收（需向用户说明）。

## 6. 架构不变量（新对话必须遵守）

- `contracts/openapi.yaml` 是接口唯一真源（v1 全部 17 端点已实现）；改动必须
  同步 fixtures/errors.md/两端实现/测试，并写 ADR；
- 文件所有权：后端只改 `desktop/pocketcode/{server,services,storage,security,discovery}`；
  Windows UI 只改 `desktop/pocketcode/gui`（`main.py` 归主集成）；手机端只改 `mobile`；
- 依赖方向 `routes → services → storage`；`features → api/storage`；反向禁止；
- 后端只用 `project_id + 相对路径`，路径防护在 `security/path_guard.py`（语法层
  400 + 真实路径层 403），不许退化成字符串 startswith；
- 手机端所有网络请求走 `src/api/transport.ts` → 原生 `PocketCodeBridge` 插件
  （TLS 指纹校验；无指纹仅放行 /v1/health 诊断）——**不要再走 WebView fetch**；
- 敏感值（device_token）用 `secureStorage`（EncryptedSharedPreferences）；草稿/缓存
  用 `diskStorage`（应用私有文件 KV）；两者都在 `src/native/index.ts`；
  **草稿/缓存不要迁回 localStorage**（Android WebView 可能被系统清理）；
- 保存内容约定：content 以 LF 表示，服务端按 newline 字段恢复（合同已写明）；
- 写操作串行化：桌面端 per-path 锁；手机端草稿操作走单一 Promise 队列
  （`enqueue`），**新代码不得绕过队列直接写草稿存储**；
- APK 每次交付：递增 `src/app/version.ts` 的 APP_BUILD + `android/app/build.gradle`
  的 versionName，用户靠连接页底部标记确认装对包；
- 桌面数据目录：`%APPDATA%\PocketCode\`（settings.json、tls/、trash/、snapshots/）。

## 7. 已知限制（对用户如实说明过）

- 编辑器已升级为 CodeMirror 6（S4a）：语法高亮/行号/折行开关已有；
  字号设置、代码折叠、文件内搜索替换、大纲在 S4 后续增量；
- 草稿：保存/刷新后保留（S4a2），跨文件管理在草稿箱；与电脑版/其他草稿的
  差异比对（并排 Diff）、导出/备份在 S4 后续增量；
- 不带 BOM 的 UTF-16 文件按"不支持的编码"拒绝（415）；
- **文件内**阅读位置已跨重启持久化（S4a）；**目录页**滚动位置记忆仍挂起（§5）；
- 回收区恢复只能恢复到原位置（原位置占用时提示先处理同名文件）；
  桌面端「清空回收区」尚无 UI（API 已有，S4 补确认界面）。

## 8. 真机验收流程参考

各阶段测试卡：docs/S0_测试卡.md、S1、S2、S3、S4。S4 剩余真机项=S4 测试卡
1-11 步（S4a）。用户参与方式：装 APK 真机操作 + 截图反馈；**不要把真机未验证的
功能说成已验证**（任务书 A 节红线）。

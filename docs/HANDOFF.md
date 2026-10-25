# PocketCode 交接文档（S3b → 下一个对话）

**交接时间**：2026-10-25  
**交接人**：主集成对话（S0→S3b 全程）  
**给新对话的第一句话**：请先完整阅读本文档与 docs/ 下三份原始文档（PRD、ARCHITECTURE、DEV_PLAN），
再读 docs/decisions/ 的 4 个 ADR，然后从「待办清单」里按顺序继续。不要跳过文档直接写代码。

---

## 1. 项目现状（一句话）

S0～S3 主链路已全部真机验收：手机 APK 可配对电脑（HTTPS+证书指纹）、浏览真实
项目目录、只读/编辑文件、多草稿离线保存、冲突处理、回收区接口。**接口合同 v1
17 个端点全部实现**。剩余：S3 收尾三件事 + 一个未解决的滚动记忆 bug + S4。

## 2. 阶段状态表（真机验收口径）

| 阶段 | 状态 | 说明 |
|---|---|---|
| S0 骨架 | ✅ 真机验收通过 | monorepo、合同、Windows 骨架、APK 空壳 |
| S1 热点连通 | ✅ 真机验收通过 | App 手动地址诊断、在线/离线、自动恢复 |
| S2 配对+只读 | ✅ 真机验收通过 | 扫码配对、HTTPS 指纹校验、真实目录浏览、离线缓存 |
| S3 可日用编辑 | 🔶 编辑主链路已真机验收 ✅ | 编辑/草稿（多份命名、重启保留）/冲突/离线保存 ✓；**滚动记忆未解决**（见 §5）；S3 收尾三件事未做（见 §4） |
| S4 体验增强 | ⬜ 未开始 | 搜索/大纲/CodeMirror/诊断/Git Diff/多文件分享 |
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
| 桌面测试 | `.venv\Scripts\python.exe -m pytest desktop/tests`（106 通过+1 跳过，跳过=符号链接需开发者模式） |
| 合同校验 | `.venv\Scripts\python.exe integration-tests/contract/check_contracts.py`（23 项；会同时核对后端路由⊆合同） |
| 移动端 | `mobile/`：`npm run typecheck && npm test && npm run build && npx cap sync android` |
| APK 构建 | `scripts/build-apk.ps1`（或 mobile/android 下 `gradle assembleDebug`，SDK 在 `%LOCALAPPDATA%\Android\Sdk`，JDK 21，系统 Gradle 8.13） |
| 产物 | `mobile\android\app\build\outputs\apk\debug\app-debug.apk`（约 27-28MB，含 ML Kit 模型） |
| 桌面启动 | `scripts\start-desktop.ps1`（HTTPS 0.0.0.0:8765，自签证书在 `%APPDATA%\PocketCode\tls`） |
| 手机 | OPPO Find X8（安卓 16），热点网段实测 `10.59.163.x`（**不要假设 192.168.43.x**） |
| 防火墙 | 已重新开启；已加放行规则 `PocketCode Server`（TCP 8765 入站） |
| 注意 | 用户电脑常开代理（TUN 虚拟网卡 vgate0）——**桌面端回环测试必须 `trust_env=False`**（pytest 里已处理，新写的 httpx 测试记得加） |

## 4. 待办清单（建议顺序）

### S3 收尾（任务书 S3 范围内未完成项）
1. **目录页新建入口**：ExplorerScreen 加「新建文件 / 新建文件夹」→ 调
   `client.createEntry()`（后端 POST /v1/projects/{id}/files 已实现并有测试）；
2. **删除入口**：文件/目录删除（进回收区，批量原子）→ `client.trashEntries()`；
   回收区列表与恢复 UI（GET /v1/trash、restore）可放目录页或连接页；
3. **电脑端快照恢复界面**：快照已自动生成（`%APPDATA%\PocketCode\snapshots\<project_id>\<path-hash>\*.bin`，
   服务层 `services/snapshots.py` 的 `list_snapshots()` 已有），缺桌面管理窗口的
   「历史版本」查看/恢复 UI（AppController 加方法 + MainWindow 加区块）；
4. **S3 测试卡补验收**：新建/删除/回收区恢复的真机步骤补进 docs/S3_测试卡.md。

### 未解决问题（用户同意挂起，接手后可重启调查）
见 §5 滚动记忆。

### S4 概览（任务书 §B）
搜索、大纲、符号导航（长按触发防误触）、Python 诊断（红黄波浪线）、CodeMirror 6
替换过渡版编辑器（语法高亮/行号/阅读位置跨重启持久化）、Git Diff、多文件分享
（「给哥哥看」五种模式）。另有挂账：命名草稿的重命名 UI、草稿导出/备份、
并排 Diff 视图、桌面端回收区清空确认界面。

## 5. 未解决问题：目录/文件滚动位置记忆（PRD §4.2/§4.3）

**症状**：从文件返回目录（或项目→目录往返）后，列表回到顶部、需要重新滑到
上次看的文件；文件阅读位置同理。

**已实现但无效的方案**（build 2026-10-25-4，用户真机确认仍无效）：
- `src/app/scrollMemory.ts`：按 key（`explorer:<projectId>` / `projects` /
  `file:<projectId>:<path>`）记录位置；保存=window scroll 事件持续记录+卸载兜底；
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
3. **怀疑保存时机**：快速"滚动→点文件"时 unmount 兜底保存的是否是最终位置；
   改为 scroll 中节流持续保存已做，可加 console 验证保存值；
4. 备选兜底方案：记录"最后打开的文件路径+目录展开状态"代替精确像素位置，
   返回后高亮并滚到该文件元素（`element.scrollIntoView`）——对用户价值等价；
5. 若像素级恢复确认不可行，PRD §4.2 的"滚动位置记忆"可按方案 4 的形式验收
   （需向用户说明）。

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

- 编辑器为过渡版 textarea（无语法高亮/行号），CodeMirror 6 在 S4；
- 冲突暂无并排 Diff（S4）；草稿导出/备份（S4）；
- 不带 BOM 的 UTF-16 文件按"不支持的编码"拒绝（415）；
- 滚动位置记忆未生效（§5）；
- 回收区恢复目前只能手机端触发，桌面端清空确认界面在 S3 收尾。

## 8. 真机验收流程参考

各阶段测试卡：docs/S0_测试卡.md、S1、S2、S3。S3 剩余真机项=§4 待办 1-3 的
对应步骤。用户参与方式：装 APK 真机操作 + 截图反馈；**不要把真机未验证的
功能说成已验证**（任务书 A 节红线）。

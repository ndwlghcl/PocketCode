# PocketCode 修复记录与验收（2026-10-26）

对应同目录 BUG_REVIEW.md 的 11 项问题。业务修复、回归测试和修复版 APK 已落地；
未把自启动、自动发现、多文件抽屉等未完成功能混入本次改动。

## 改动与证据

| 原编号 | 修复 | 回归证据 |
|---|---|---|
| 1 | manifest/搜索扫描跳过符号链接、Windows 重解析点，校验真实路径 | 外部 junction 与指回本目录的循环 junction 均不被扫描 |
| 2 | Git 使用 literal pathspec、限制 status 授权目录范围，关闭外部 diff/textconv | 授权子目录只返回本目录变更，特殊路径不泄露兄弟文件 |
| 3 | 请求冻结正文/草稿身份；响应缓存仅保存已发送正文，后续输入保留为未同步草稿 | 保存 A 时输入 B，缓存为 A、草稿为 B，继续可保存；响应后输入也不会被延迟切页打断 |
| 4 | 刷新阅读数据不改活动草稿的编辑正文与来源版本 | 刷新电脑版后进入/退出编辑，原草稿仍保留 |
| 5 | 临时文件 fsync 后、替换前再次复核真实位置及正文版本 | 快照期间、刷盘期间发生 IDE 修改时返回冲突，原文件不被替换；保证边界见下文 |
| 6 | 正文、长度、hash 来自同一份 raw 字节，mtime 取读取句柄 | 读完正文后发生修改，返回版本仍匹配返回的正文 |
| 7 | 同一回收区的不同仓储对象共用事务锁 | 6 个并发删除请求的恢复索引全部保留 |
| 8 | 恢复按当前项目授权与原相对路径重新验证 | 已撤销项目返回 404，路径被联接到外部后返回 403；payload 保留 |
| 9 | 原生 KV 使用固定长度哈希文件名，记录自带逻辑 key；支持旧记录读取与逐次迁移 | 实际 Java 仓储测试验证长中文 key、括号等字符、重开/枚举/更新/删除及旧记录兼容 |
| 10 | Git 状态使用 NUL 分隔，保留原始 Unicode/空格路径 | 中文空格文件名正常列出并读取 Diff |
| 11 | 先按 BOM 识别文本编码，再拒绝不支持的二进制控制字符，统一解码错误 | 二进制及损坏 BOM 拒绝；正常 UTF-16 阅读和搜索仍可用 |

一起补上了这些相邻问题：自动保存失败时明确提示并阻止“完成”静默离开；
放弃冲突草稿前先成功加载电脑版；CodeMirror 的外部正文同步不再误当成用户
输入，移除重复的文档变更回调；保存/创建越界路径正确返回 403；修正桌面
快照恢复异常分支缺失的 PathGuardError 导入。

## 自动验证

- 桌面 pytest：150 通过、1 跳过（符号链接权限用例）。
- 手机 Vitest：72 通过；包含 4 个 FileScreen 处理逻辑回归。
- Android 实际 Java 仓储 JUnit：2 通过、0 失败。
- 接口合同：29 通过、0 失败；新增错误示例与 403 响应声明。
- TypeScript 类型检查、web 生产构建、Capacitor sync、Android assembleDebug 成功。
- APK 已核对 versionCode/versionName，压缩包内包含新 web build 标记和新原生仓储类。

前端 FileScreen 测试使用 mock hook harness，不等于 React DOM/Android 真机验收；
Java 测试执行真实磁盘存储，但未模拟 Android 断电、系统杀进程或设备磁盘故障。

## 保证边界

第 5 项补齐了缺失的最终版本复核，覆盖原报告的可复现场景。但这是**乐观并发
控制**：最后一次检查和 os.replace 之间依然不是跨进程的原子条件写入，不能
宣称任何外部 IDE 在任意时刻写入都绝对不会相撞。要完全消除这条边界，需要
外部编辑器共同参与写入协议，不能靠本服务内的一把锁保证。

新 KV 兼容旧草稿，成功写入新记录后才删除对应旧文件；不要卸载 App 或清除
应用数据。旧 APK 无法识别新记录格式，不建议在写入新草稿后直接降级 APK。

## 安装与真机验收

产物：`mobile/android/app/build/outputs/apk/debug/app-debug.apk`。

- versionName：`1.0-s4ef-fix1`，versionCode：`9`。
- 连接页标记：`S4ef fixes · build 2026-10-26-1`。
- 电脑端：从托盘退出 PocketCode，再重新启动服务，使新的后端代码生效。
- 手机端：覆盖安装 APK，保留应用数据；本次包含原生存储改动，只有 web 构建不够。

建议按顺序验收：

1. 安装前准备一份旧草稿；覆盖安装后确认它仍可读取和修改。
2. 打开 `docs/notes(1).py` 和较长中文路径文件，编辑草稿后关闭重开，确认内容保留。
3. 保存 A 的过程中继续输入 B，确认 B 仍显示未保存，电脑只有 A；再次保存才变成 B。
4. 已有草稿时在阅读页刷新电脑版，再进编辑，确认仍显示草稿内容。
5. 电脑端同时修改源文件，确认手机冲突提示；删除/恢复、撤销项目授权后拒绝恢复。
6. 查看中文/带空格文件名的 Git Diff，确认可打开。

## 再次运行回归

```powershell
# 仓库根目录
.\.venv\Scripts\python.exe -m pytest desktop/tests
.\.venv\Scripts\python.exe integration-tests/contract/check_contracts.py
# 原审查脚本入口已转为执行维护中的修复后回归
.\.venv\Scripts\python.exe docs/reviews/2026-10-26/backend_repro.py
```

```powershell
# mobile 目录
npm run typecheck
npm test
# mobile/android 目录
gradle :app:testDebugUnitTest --no-daemon
```

更详细的设计、迁移与合同说明见 `docs/decisions/ADR-0005-file-safety-and-native-kv-migration.md`。

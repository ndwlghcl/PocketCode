# PocketCode 缺陷审查（2026-10-26）

> 以下是修复前的历史审查记录。当前修复、验证结果和剩余保证边界见
> [FIXES.md](FIXES.md)。原复现脚本入口已更新为运行修复后回归。

本次以用户提供 ZIP 中的 PRD v1.1 为需求依据，参考架构文档、仓库内补充需求和现有实现。附件中的开发分工和交付指令只作为文档内容阅读，没有据此开展实现。**没有修改业务代码。**

发现 11 项明确问题：9 项 P1（数据一致性、草稿持久化或授权边界），2 项 P2（特定输入的功能错误）。P1 表示应优先修复，不代表所有问题在普通单次操作中都会发生。尚未实现的需求另列，不计入 11 项。

## 验证结果与边界

- 原有桌面测试：**136 通过、1 跳过**；跳过用例需要 Windows 符号链接权限。
- 原有移动端测试：**67 通过**；TypeScript 类型检查和生产构建通过。
- 接口合同校验：**27 通过、0 失败**。
- 补充后端复现脚本全部断言成立，使用合成文件和临时 Git 仓库。
- 补充前端 3 项检查通过：前两项执行真实 FileScreen 事件处理和草稿仓储，以轻量 hook harness 替代 React 渲染环境；第三项核对 JS 生成的存储键与 Java 校验规则是否兼容。**这不是 Android 真机或完整 React DOM 测试。**
- 本次没有重新安装 APK、运行真机交互或验证断电恢复。以下“复现”均指注明的服务级、组件处理逻辑级或静态规则核验。
- 补充脚本刻意断言“缺陷确实出现”，因此它们通过不表示产品没有 bug；修复后应改为断言期望的正确行为。

## 1. [P1] Windows junction 绕过目录权限，搜索泄露授权范围之外的正文

位置：[search.py:68](D:/code/PocketCode/desktop/pocketcode/services/search.py:68)、[files.py:121](D:/code/PocketCode/desktop/pocketcode/services/files.py:121)。

触发：授权 `project/`，其中 `linked/` 是指向另一目录的 Windows junction（目录联接）。调用项目搜索即可命中目标目录里的正文；manifest 也会列出目标目录中的文件和元数据。

原因：Windows junction 的 `is_dir(follow_symlinks=False)` 仍为 true，而 `is_symlink()` 为 false。扫描器递归前没有执行根目录包含校验；单文件读取里的 path_guard 无法保护独立实现的搜索与目录扫描。

验证：在两个合成目录间创建 junction，搜索返回了授权根之外的 `OUTSIDE_SENTINEL_PRIVATE`。建议扫描每层入口前解析真实路径并校验位于授权根内，明确处理 junction、符号链接和循环。

## 2. [P1] Git 将用户路径解释成 pathspec，可读取未授权目录的 Diff

位置：[gitinfo.py:64](D:/code/PocketCode/desktop/pocketcode/services/gitinfo.py:64)、[gitinfo.py:107](D:/code/PocketCode/desktop/pocketcode/services/gitinfo.py:107)。

触发：只授权一个 Git 仓库的 `allowed/` 子目录，请求 Diff 的路径设为 `:(top)private.py`。现有语法检查允许这个字符串，Git 会把它解释为“仓库顶层的 private.py”，返回授权子目录之外的代码差异。status 也没有限定子目录，会返回整个仓库的变更文件名。

验证：真实测试仓库中，只以 `allowed/` 作为服务根调用，成功读取了兄弟文件 private.py 的 `+PRIVATE NEW VALUE`。

建议：对外路径必须保持字面文件路径语义，关闭 Git pathspec 魔法；限制 status 的范围；把 Git 返回的仓库相对路径转换为授权根相对路径并复核边界。argv 列表和 `--` 能阻止 shell/选项注入，但不会关闭 Git 自己的路径匹配语法。

## 3. [P1] 手机保存期间继续输入，未发送的内容被标成“已同步”

位置：[FileScreen.tsx:282](D:/code/PocketCode/mobile/src/features/explorer/FileScreen.tsx:282)、[FileScreen.tsx:288](D:/code/PocketCode/mobile/src/features/explorer/FileScreen.tsx:288)、[FileScreen.tsx:316](D:/code/PocketCode/mobile/src/features/explorer/FileScreen.tsx:316)。

触发：输入 A → 点保存 → 请求返回前继续输入 B。请求发送的是 A；响应处理中却再次读取 `editTextRef.current`，把 B 放入电脑版本缓存和活动草稿，并把它与 A 的版本号绑定，界面显示“已同步”。

验证：组件处理逻辑复现中，请求正文为 PHONE A，响应后缓存和草稿正文为 PHONE B NOT ON PC，界面仍显示“已同步”。

建议：点击保存时冻结正文、草稿 ID、来源版本；响应只确认这次发送的内容。如果编辑器后来又有变化，应保留 B 并显示“未保存”。900ms 后自动切阅读模式的定时器也应服从同一编辑状态检查。

## 4. [P1] 阅读页刷新后再次进入编辑，会覆盖原有活动草稿

位置：[FileScreen.tsx:363](D:/code/PocketCode/mobile/src/features/explorer/FileScreen.tsx:363)、[FileScreen.tsx:373](D:/code/PocketCode/mobile/src/features/explorer/FileScreen.tsx:373)、[FileScreen.tsx:858](D:/code/PocketCode/mobile/src/features/explorer/FileScreen.tsx:858)。

触发：已有活动草稿 A → 阅读页刷新电脑版本 B → 进入编辑 → 点“完成”。刷新直接修改编辑正文与 baseVersion，但保留 A 的活动 ID；进入编辑时没有重新载入 A；退出编辑又无条件 flush，把 B 写回 A。

验证：复现中，刷新后磁盘草稿仍为 MY PRECIOUS IDEA，但随后仅进入并退出编辑，草稿就变成 PC NEW。

这违反仓库补充确认的“阅读页刷新完全不动草稿”。建议阅读数据和活动草稿的编辑状态分离；进入编辑时明确恢复活动草稿；无修改退出时不要无条件改写草稿。

## 5. [P1] 服务端校验后未再次复核，保存过程中的 IDE 修改被无提示覆盖

位置：[writes.py:82](D:/code/PocketCode/desktop/pocketcode/services/writes.py:82)、[writes.py:98](D:/code/PocketCode/desktop/pocketcode/services/writes.py:98)、[writes.py:107](D:/code/PocketCode/desktop/pocketcode/services/writes.py:107)。

触发：服务端读到旧内容 A 并确认版本 → PyCharm/Codex 写入 B → 服务端替换为手机内容 C。当前代码只在前半段检查一次，快照也只保存 A；B 会同时从原文件和 PocketCode 快照中消失。

验证：在真实快照调用之后插入一次模拟 IDE 写盘，保存成功覆盖为 phone，快照中没有 IDE newer。

建议：让版本复核尽量贴近替换，对变更重新处理冲突和快照，并明确外部 IDE 并发写入时的保证边界。原子替换保证“不会只写半个文件”，不等于“版本检查和写入是同一个原子操作”；服务内的路径锁也约束不了外部 IDE。

## 6. [P1] 读文件时内容和版本号来自两次读取，可能绕过后续冲突检测

位置：[files.py:185](D:/code/PocketCode/desktop/pocketcode/services/files.py:185)、[files.py:187](D:/code/PocketCode/desktop/pocketcode/services/files.py:187)。

触发：第一次读出正文 A → 电脑保存 B → 版本缓存重新读盘得到 B 的 hash。响应于是返回“A 的正文 + B 的版本号”。手机基于 A 修改再保存时，服务端发现当前版本确实等于 B 的 hash，就会允许覆盖 B。

验证：在正文读取和哈希查询之间安排一次 IDE 写盘，成功构造上述响应，并确认基于旧正文的保存被接受。

建议：返回的内容和 SHA-256 必须来自同一份 raw 字节；必要时用前后 stat 检查是否需要重试。这个问题发生在读取阶段，与第 5 项发生在保存阶段的竞态不同。

## 7. [P1] 并发删除时回收区锁不共享，可能丢失恢复索引

位置：[mutations.py:63](D:/code/PocketCode/desktop/pocketcode/server/routes/mutations.py:63)、[trash.py:35](D:/code/PocketCode/desktop/pocketcode/services/trash.py:35)。

触发：两台已配对设备或两个并行请求同时删除不同文件。每次请求都会创建一个新的 TrashStore，每个实例有自己的 RLock；两次操作可同时读到旧索引，随后用各自结果覆盖索引。固定名称的 `.json.tmp` 还会造成临时文件竞争。

验证：用两个真实 TrashStore 实例，以屏障安排“两次读都先发生，再依次执行真实写入”。两个文件都被移入回收区，最终索引只有一条，另一条无法从正常恢复入口找到。payload 仍可能存在，不等于已被物理销毁。

建议：应用级共享回收区实例或共享锁，保证整段读—改—写互斥；不能只为每个对象各自加锁。

## 8. [P1] 移除项目授权后，手机仍可通过回收区向原目录写入

位置：[mutations.py:220](D:/code/PocketCode/desktop/pocketcode/server/routes/mutations.py:220)、[trash.py:119](D:/code/PocketCode/desktop/pocketcode/services/trash.py:119)。

触发：删除文件到回收区 → 桌面移除该项目授权 → 已配对手机调用恢复。恢复只检查设备身份和 trash_id，直接使用索引中的 `source_abs`，没有检查项目仍被授权，也没有重新解析目标路径的真实边界。

验证：通过实际恢复路由函数执行时，授权项目数已为 0，文件仍被恢复到已撤销的目录。

建议：恢复时按 project_id 重新确认授权，并对 original_path 再执行 path_guard。历史绝对路径不是当前授权证明；目录结构变化后也应重新检查真实路径。

## 9. [P1] Android 存储键规则拒绝正常文件名和较长中文路径，草稿无法落盘

位置：[PocketCodeBridgePlugin.java:211](D:/code/PocketCode/mobile/android/app/src/main/java/com/pocketcode/app/PocketCodeBridgePlugin.java:211)、[draftStore.ts:33](D:/code/PocketCode/mobile/src/storage/draftStore.ts:33)、[cacheStore.ts:117](D:/code/PocketCode/mobile/src/storage/cacheStore.ts:117)。

触发与证据：

- 合法文件名 `docs/notes(1).py` 中的括号不会被 encodeURIComponent 编码，但 Java 存储键正则禁止括号，dataSet/dataGet 都会返回 ERR_KEY。`! ' *` 也存在同类兼容问题。
- 使用 UUID 项目 ID 时，`docs/这是一份稍长一点的中文需求说明文档.md` 生成的草稿键长为 **209**，超过 Java 的 200 字符上限。中文经过百分号编码会明显变长，实际路径远未达到合同的 512 字符上限。

结果：这些文件的草稿无法写入，缓存和阅读位置也受影响；草稿自动保存调用缺少面向用户的错误处理，界面可能仍给出已自动保存的文案。

验证级别：已核对真实 TS 键生成算法与 Java 校验规则，并运行规则兼容性断言；尚未在手机上执行这些文件名。现有单测的内存 KV 不施加原生键限制，因此没有发现。

建议：存储文件名使用固定长度哈希，真实路径放在值或索引中；保留枚举草稿所需元数据，同时把持久化失败呈现给用户。

## 10. [P2] 中文或带空格文件名的 Git 路径解析错误，Diff 无法打开

位置：[gitinfo.py:64](D:/code/PocketCode/desktop/pocketcode/services/gitinfo.py:64)、[gitinfo.py:89](D:/code/PocketCode/desktop/pocketcode/services/gitinfo.py:89)。

触发：仓库存在中文文件名，且 Git 使用默认的 core.quotepath 设置。porcelain 文本输出会使用带引号的转义路径，代码直接把整段文本当文件路径。引号/转义可能导致路径校验失败或找不到对应 Diff。

验证：中文.py 被返回为包含 `\344\270\255...` 的转义字符串，进一步调用现有路径校验会得到 PATH_INVALID。带空格路径同样会受引号语义影响。

建议：使用 `--porcelain=v1 -z` 并正确解析 NUL 分隔字段，保留实际文件名，避免依赖 Git 显示字符串。

## 11. [P2] 能被 UTF-8 解码的二进制被当作可编辑文本

位置：[files.py:206](D:/code/PocketCode/desktop/pocketcode/services/files.py:206)。

触发：二进制字节恰好全处于可解码范围，例如 `00 01 02 0D 03`。当前 _decode 只用 UTF-8 解码是否成功作为判断，会返回 utf-8 文本，并允许进入编辑流程。

验证：上述字节被实际读取服务接受为包含 NUL 的字符串。经过编辑器和换行恢复后，文件可能不再保持原来的字节语义，违背“二进制拒绝、避免损坏”的需求。

建议：统一文件读取与搜索的二进制识别规则，先识别支持的 BOM 编码，再检测不应按文本处理的字节；不要粗暴拒绝所有包含 NUL 的原始字节，否则会误伤正常 UTF-16。

## 尚未兑现的需求，不计入上述 bug 数

- PRD §3.3 的登录自启动：桌面复选框仍被禁用，不能视为已交付。
- PRD §3.2 和架构 §3.2 的地址变化后自动发现：desktop/discovery 仍为占位，手机依赖原来的 baseUrl 重试；同一地址断线恢复与 IP 改变后找回电脑应分别验收。
- PRD §4.1 默认逐层目录浏览和 §4.4 已打开文件抽屉：目前实际导航仍主要是展开目录树和一个 viewer。
- 补充需求 ADD-1 的手动横竖屏切换：本次检索没有发现对应原生桥/插件或界面入口；系统旋转不等于手动切换已实现。

交接文档里已经明确挂账的目录滚动位置问题，没有作为本次新发现重复计数。README 与 HANDOFF 的阶段描述也有明显不同，建议后续统一验收状态，避免把“代码存在”等同于“需求完成”。

## 复现命令

在仓库根目录运行原有检查：

```powershell
.\.venv\Scripts\python.exe -m pytest desktop/tests
.\.venv\Scripts\python.exe integration-tests/contract/check_contracts.py
```

在 mobile 目录运行原有检查：

```powershell
npm test
npm run typecheck
```

补充复现：

```powershell
# 仓库根目录：仅构造合成文件，临时目录自动清理；Windows 下测试 junction。
.\.venv\Scripts\python.exe docs/reviews/2026-10-26/backend_repro.py

# mobile 目录：组件处理逻辑与原生键规则兼容性核验。
node node_modules/vitest/vitest.mjs run --config ../docs/reviews/2026-10-26/vitest.config.ts
```

建议先修权限边界（1、2、8），再修保存和草稿一致性（3—7、9），最后处理 10、11，并把上述复现改写为正式回归测试。最需要理解的是：**缓存、草稿和电脑文件是三份不同的数据；一次成功保存只能确认那次实际发送的正文。**

# Changelog / 更新记录

## 0.1.10 — 2026-10-15

- 软件列表优先显示桌面快捷方式的真实图标，其次是开始菜单和 EXE 内置图标。支持自定义本地 ICO、环境变量和正负资源索引；带参数的网页或游戏入口不会把专用图标套到共用程序上。
- 可见及邻近条目批量读取 64×64 透明 PNG，独立内存缓存包含失败结果。重新扫描刷新缓存，旧请求不会覆盖新结果；读取失败保留首字兜底。仅访问可验证的本地文件，不执行快捷方式，不上传图标，不把图像数据写入设置。可选快捷方式路径兼容旧设置与旧版回滚，不参与分流指纹。
- App rows prefer native desktop shortcut icons, followed by Start Menu shortcuts and embedded EXE resources. Custom local ICOs, environment variables and positive/negative resource indices are supported; parameterized website and game entries do not supply custom logos to shared executables.
- Visible and nearby rows load transparent 64×64 PNGs in bounded batches. Independent caches include failures; rescan refreshes them and ignores late results from old generations. Unreadable icons retain initial letters. Only verifiable local files are read, shortcuts are never executed, and image data is neither uploaded nor saved in settings. Optional shortcut paths remain compatible with old settings and binaries and do not affect routing fingerprints.

- Windows 构建补正：异步 Tauri 命令按框架要求返回 Result；读取失败仍返回空图标，不影响选择和直连。
- Windows build compatibility: the asynchronous Tauri command returns Result as required by the framework; extraction failures still resolve to empty icons.

- 本机窗口验收发现扫描脚本超过 Windows 命令行长度限制，改为短启动命令和带长度的 UTF-8 标准输入传输；保留原始业务输入、现有退出码、隐藏窗口和超时保护，避免长脚本影响扫描与自动检查。
- Native verification found the scanner exceeded the Windows command-line limit. A short bootstrap now reads framed UTF-8 script bytes from stdin, preserving original business input, exit codes, hidden workers and timeout handling.

### Validation / 验证

- 新增 Windows 脚本传输回归 4 组：超过 100 KiB 的脚本和业务数据、中文与表情、内部编码重设、原始 JSON、截断输入及退出码均通过；CI 另调用真实 Rust 辅助入口测试大输入、提前输出和错误优先级。
- 本机通过短启动入口完成真实软件扫描、5 个已选图标提取及只读 Clash 诊断，保留规则模式与 54 条已加载程序规则。
- Native scanning, extraction for five selected apps and read-only Clash diagnosis passed through the short bootstrap, retaining rule mode and 54 loaded application rules.
- Four Windows transport groups passed for scripts and input over 100 KiB, Unicode, internal encoding resets, raw JSON, truncated frames and exit status. CI additionally exercises the actual Rust helper with large input, early output and error-priority cases.
- 测试启动器兼容 Windows PowerShell 5.1 父进程的带 BOM UTF-8 编码，并在启动后恢复父编码；普通编码与带 BOM 环境均通过相同回归。
- The test launcher handles BOM-bearing UTF-8 in a Windows PowerShell 5.1 parent and restores the parent encoding after startup. The same regressions pass under both parent encodings.
- 本机通过 92/92 Node 回归、9 组扫描器测试、8 组原生图标测试及 TypeScript / Vite 构建。原生测试覆盖透明图标、自定义资源、环境变量、正负索引、损坏和缺失回退、桌面优先、路径边界、批次数限及 100 次读取的 USER/GDI 句柄释放。
- 浏览器 Tauri 模拟接口使用本机真实 PNG 通过 6 组图标界面场景，包括显示、语言/主题缓存、扫描刷新、提取与解码失败、旧结果隔离及可见区域加载。Rust 缓存测试和 Windows 打包由本次提交的 GitHub Actions 执行；本机更新使用同一成功构建。
- Local checks passed: 92/92 Node regressions, nine scanner groups, eight native icon groups and TypeScript / Vite build. Native tests cover alpha, custom resources, environment variables, signed indices, fallback, desktop precedence, path boundaries, batch limits and USER/GDI ownership after 100 extractions.
- Six browser groups passed with mocked Tauri commands and a real locally extracted PNG, covering display, language/theme reuse, rescan, extraction/decode failures, stale results and viewport loading. GitHub Actions executes Rust cache tests and Windows packaging for this commit; local replacement uses that exact successful build.

### Rollback / 回滚

Previous working commit / 上一可用提交: [a069863f005138ba555b4c3f1fa3864eb31376e2](https://github.com/frank-zhi-0804/clash-app-bypass/commit/a069863f005138ba555b4c3f1fa3864eb31376e2), version 0.1.9. Revert the icon feature and its build/transport fixes together; preserve history, settings and release tags. / 使用 git revert 一并撤销图标功能及构建、传输修正，保留历史、设置和发布标签。

## 0.1.9 — 2026-10-14

- 新增窗口顶部与设置页的「中文 / English」切换；语言保存在本机，重开恢复，旧设置默认中文。导航、应用与网站页面、帮助、确认框、提示、无障碍名称及窗口标题同步切换。
- 使用 i18next / react-i18next、集中翻译资源与 TypeScript 语义键约束；后端返回稳定消息描述符，延迟结果与已有通知按当前语言呈现，英文数量文案支持复数。
- 语言保存与分流操作区分处理，保存失败保留当前显示并支持重试；切换语言不改变分流指纹、不恢复撤销后的自动应用、不清除已有分流错误。保留旧版可读取的扫描 metadata 字符串，增加翻译描述符字段以支持回滚。
- Added Chinese / English selectors in the header and Settings, persisted locally and restored on reopening; existing settings default to Chinese. Navigation, app and website pages, help, dialogs, messages, accessibility names, and window titles switch together.
- Centralized i18next / react-i18next resources and typed semantic keys. Backend message descriptors and delayed notifications render in the current language; English count-dependent messages support plurals.
- Language-save failures retain the current display and support retry. Switching language does not change routing fingerprints, resume undone rules, or clear routing failures. Legacy scanner metadata remains readable by older binaries, with additional descriptors for localization.

### Validation / 验证

- 本机 `npm test` 80/80 通过，含翻译键与插值一致、0/1/2 复数、嵌套消息、未知消息回退和分流状态保护；扫描器 8 组回归通过，诊断传输 14 项包含在完整 Node 测试中。
- 浏览器 Tauri 模拟接口通过 10 个语言场景：立即切换和本机保存、重开、撤销保持、保存失败重试、已有后端错误切换、窄窗口、自动同步互斥、未知语言回退、取消的初始化晚返回及网址解析延迟。真实桌面标题和设置保留另在成功构建的本机应用中验收。
- TypeScript / Vite 生产构建通过；Rust 兼容性、消息协议与规则测试及 Windows 打包由本次提交的 GitHub Actions 执行，本机没有已安装的 Rust 工具链。
- Local `npm test` passed 80/80, including resource/parameter parity, 0/1/2 plurals, nested messages, unknown-message fallback, and routing invariants. Eight scanner regression groups passed; fourteen diagnostic transport cases are included in the full Node test run.
- Ten browser scenarios passed with mocked Tauri commands, covering immediate switching and persistence, reopen, undo, preference-save retry, existing backend errors, narrow windows, synchronization guards, unknown languages, cancelled startup responses, and delayed URL normalization. Native titles and setting preservation are additionally checked using the successful Windows build.
- TypeScript / Vite production build passed. GitHub Actions executes Rust compatibility/message/routing tests and Windows packaging for this commit; no local Rust toolchain is installed.

### Rollback / 回滚

Previous working commit / 上一可用提交: [fcde6d0270a2fab15183701c21edae5a78206c84](https://github.com/frank-zhi-0804/clash-app-bypass/commit/fcde6d0270a2fab15183701c21edae5a78206c84), version 0.1.8. Use git revert on this isolated language feature commit; keep settings, backups, and release tags. / 使用 git revert 撤销本次独立语言功能提交，保留设置、备份与发布标签。

## 0.1.8 — 2026-10-11

- 新增“网站直连”：粘贴网址，按公共后缀列表整理主域名，并为该域名及子域名生成直连规则。支持复合后缀、国际化域名和托管平台的独立站点边界。
- 网站新增、去重、删除与重开恢复沿用本机设置和自动同步。网站可单独使用，也可与软件直连规则组合；撤销保留选择并暂停自动应用。
- 网站规则状态与真实连接分开描述。原订阅规则、冲突检测、备份和恢复流程继续保留。
- Added website bypass: normalize pasted URLs using the Public Suffix List and generate direct rules for the registrable domain and its subdomains, including compound suffixes, IDNs, and private hosting boundaries.
- Website additions, deduplication, removal, and reopening use local settings and automatic synchronization, independently or alongside application rules. Undo retains selections and pauses automatic application.
- Loaded website rules are distinguished from observed connections. Subscription rules, conflict detection, backups, and recovery remain supported.

### Validation / 验证

- 本机通过 `npm test`（69/69）、Windows 扫描器回归测试及 TypeScript / Vite 生产构建。
- 浏览器集成测试通过 5 个自动重连场景和 7 个网站场景；Tauri 命令使用模拟数据，真实网址解析由 Rust 测试覆盖。
- 本机隔离 Mihomo v1.19.29 验证根域、一级与多级子域的 `DomainSuffix / example.com / DIRECT` 连接证据；相似域名命中 `MATCH / REJECT`。混合程序规则、在线移除、相同订阅规则保留和实际写出配置的重启持久性均通过。
- GitHub Actions 执行本次提交的 Rust 后端测试和 Windows 打包；本机未安装 Rust 工具链。
- Local checks passed: `npm test` (69/69), Windows scanner regression tests, and TypeScript / Vite production build.
- Browser integration passed five reconnection scenarios and seven website scenarios using mocked Tauri commands; Rust tests cover the actual URL parser.
- An isolated local Mihomo v1.19.29 observed `DomainSuffix / example.com / DIRECT` for the root and nested subdomains, with similar domains matching `MATCH / REJECT`. Mixed application rules, live removal, identical subscription-rule preservation, and restarting from the written configuration passed.
- GitHub Actions runs this commit's Rust backend tests and Windows packaging; no local Rust toolchain is installed.

### Rollback / 回滚

Previous working commit / 上一可用提交: [6abbe8d105318e14b1bed881373384bce2597aa5](https://github.com/frank-zhi-0804/clash-app-bypass/commit/6abbe8d105318e14b1bed881373384bce2597aa5), version 0.1.7. Revert the isolated website feature commit to preserve subsequent history; do not reset remote history or move release tags. / 使用 git revert 撤销本次独立功能提交，保留后续历史；不重写远端历史或移动发布标签。

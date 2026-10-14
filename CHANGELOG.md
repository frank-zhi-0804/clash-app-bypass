# Changelog / 更新记录

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

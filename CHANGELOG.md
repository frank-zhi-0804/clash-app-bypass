# Changelog / 更新记录

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

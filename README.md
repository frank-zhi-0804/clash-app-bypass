<p align="center"><img src="app-icon.png" width="128" alt="Clash App Bypass 图标" /></p>

# Clash App Bypass · 直连助手

**中文** | [English](README.en.md)

面向 Windows 用户的 Clash Verge Rev 应用直连助手。选择不使用代理的软件，识别其关联进程，按完整程序路径生成直连规则。独立第三方项目，与 Clash Verge Rev 官方没有隶属关系。当前源码版本：**0.1.2**；界面目前为中文。

## 功能

- 扫描开始菜单、桌面快捷方式和可读取路径的运行进程，也可手动添加 `.exe`。
- 搜索、运行中筛选、已选择筛选，展开查看关联进程。
- 根据产品信息和少量已知辅助程序名称关联同目录下的程序。
- 软件选择保存在本机；应用前重新扫描并检查程序路径。
- 使用 `PROCESS-PATH,...,DIRECT`，避免将其他同名程序一起直连。
- 管理全局扩展脚本中的专属区段，提供备份、冲突检测和撤销。
- 支持明暗主题；应用图标由项目根目录的 `app-icon.png` 生成。

## 下载安装

前往 [GitHub Releases 下载最新版](https://github.com/frank-zhi-0804/clash-app-bypass/releases/latest)。下载文件名包含 `setup` 的 EXE 安装包，或便携版 `clash-app-bypass.exe`。便携版需要系统安装 WebView2 Runtime，`SHA256SUMS.txt` 提供文件校验值。

已发布的 v0.1.1 经作者在本机实际运行确认可用。当前源码的新改动可从 [GitHub Actions](https://github.com/frank-zhi-0804/clash-app-bypass/actions/workflows/windows-build.yml) 成功构建中下载 `clash-app-bypass-windows-x64` 产物；正式发布版本以 Releases 为准。

## 本次优化（0.1.2）

- 启动扫描与 Clash 检测分别处理失败，支持重试初始化和扫描。
- 刷新和应用前清理失效辅助程序路径；主程序失效时保留选择并提示重新添加。
- 补充 QQ 的 `QQEX.exe` 与 WeGame 的 `qbblinktrial\browser.exe` 关联；直连规则写入后不依赖助手持续运行。
- 显示“未应用”“规则已写入”“待重启 Clash”等状态；改变主题不会把规则标记为未应用。
- 重启 Clash 后点击“已重启，检查状态”或重新扫描，更新状态提示。状态表示配置操作进度，实际路线可在 Clash 中查看。

## 使用

1. 打开桌面版并等待扫描。自动检测失败时，在设置中选择包含 `profiles.yaml` 的 Clash Verge Rev 配置目录。
2. 为需要直连的软件打开“不使用代理”，展开关联清单检查识别结果。
3. 设置“其他流量”：默认“使用代理”，代理组为 `GLOBAL`。确保它最终选择可用代理节点，而不是 `DIRECT`。
4. 从系统托盘**完全退出 Clash Verge Rev**，确保内核也停止。
5. 点击“应用到 Clash”，完成后重新打开 Clash Verge Rev，并使用**规则模式**。需要接管不遵循系统代理的应用时，可启用 TUN。
6. 在 Clash 的连接页面确认新连接是否使用 `DIRECT`，其他流量是否走预期代理。

默认规则顺序为“所选程序路径 → DIRECT，其余流量 → MATCH,所选代理组”。这会覆盖运行配置中的订阅分流规则，但保留订阅原文和原脚本。“遵循订阅规则”则保留订阅分流行为，不保证特定网站走代理。

取消某个软件的选择后再次应用，会移除其直连规则。清空选择时，“使用代理”仍保留默认代理规则；点击“撤销本工具规则”可移除本工具管理段并保留软件选择。

## 适用范围和限制

- 当前仅支持 Windows。浏览器预览使用示例数据，不扫描真实软件、不修改 Clash。
- 不保证识别全部相关进程。目录外共享服务、特殊启动器、无法读取路径的进程需要单独添加。
- 关联扫描最大深度为 3，最多访问 2000 个目录项，不跟随 junction / symlink；不会将同目录所有 `.exe` 一律直连。
- 主程序路径变化后需重新添加；失效辅助程序路径在刷新或应用前清理，仍存在的历史辅助程序路径保留。
- 默认适配具有 `uid: Script` 的全局脚本结构；不支持的入口形式或指向配置目录外的脚本会停止操作。
- 订阅级扩展可能覆盖全局规则或进程识别设置，请检查最终配置和实际连接。
- 应用成功只表示脚本已写入。已有连接可能继续使用旧路线；当前需要退出并重启 Clash，没有实时刷新或后台自动更新规则。

## 本机数据、备份与撤销

Tauri 的 `app_data_dir`（应用标识 `io.clashappbypass.app`）存放 `settings.json`、`ownership.json` 和 `backups/`。这些数据包含程序路径和原扩展脚本，本工具不会上传，请勿提交到公开仓库。

首次改写前备份原脚本，每次写入前检查 Clash 进程和源文件内容。管理区段被外部修改或缺少本机归属记录时，会停止修改。升级沿用同一应用数据目录和管理标记。

无法正常撤销时，退出 Clash，在本机数据目录查找修改前备份，通过 Clash 的全局扩展脚本编辑器检查并恢复。其他规则已变化时，请勿盲目覆盖整份旧脚本。

## 开发与构建

需要 Node.js 22 或更高版本；桌面版还需要 Rust stable（MSVC）、Visual Studio C++ Build Tools、Windows SDK 和 WebView2。详见 [Tauri 环境要求](https://v2.tauri.app/start/prerequisites/)。

```powershell
npm install
node scripts/generate-icon.mjs
npm run dev           # 浏览器预览
npm run desktop       # 桌面开发
npm run desktop:build # Windows 安装包
```

也可双击 `start-web-preview.cmd`、`start-desktop.cmd` 或 `build-windows.cmd`，启动脚本会安装缺失的前端依赖并生成图标。直接执行桌面构建前，请先生成图标。安装包输出到 `src-tauri/target/release/bundle/nsis/`，便携程序为 `src-tauri/target/release/clash-app-bypass.exe`。

### 图标

`app-icon.png` 是原始图标。`node scripts/generate-icon.mjs` 使用本地 Tauri CLI 生成 `src-tauri/icons/` 中的桌面图标，并将 128 像素版本复制到 `public/app-icon.png`，供侧栏和浏览器标签使用。替换原图后重新运行该命令即可。

### 验证

```powershell
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File tests/scanner.test.ps1
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

[Build Windows 工作流](.github/workflows/windows-build.yml) 在推送 `main`、推送 `v*` 标签或提交 PR 时运行，也支持手动触发。它执行规则、扫描器、前端和 Rust 检查，打包并上传 Windows 产物及依赖锁文件；不会自动创建 GitHub Release。

已发布的 v0.1.1 经作者在 Windows 本机运行验证。自动构建执行规则、扫描器、前端和 Rust 检查并生成安装包。

## 许可证

采用 [MIT 许可证](LICENSE)。项目代码独立编写，未复制 Clash Verge Rev 或其他应用分流工具的源码。

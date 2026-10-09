# Clash App Bypass · 直连助手

## v0.1.1：只排除选中软件，其他流量继续代理

默认“其他流量”为“使用代理”，代理组为 GLOBAL，沿用 Clash 全局模式选中的节点或组。请确保 GLOBAL 没有选择 DIRECT，代理组最终使用的是可用代理节点。

规则顺序为：所选程序路径 → DIRECT，其余流量 → MATCH,所选代理组。此模式覆盖运行配置中的原订阅分流规则，但保留订阅原文与原脚本，撤销后恢复原有处理方式。Clash 仍需使用规则模式。

例如：选择无畏契约“不使用代理”，其他流量选择“使用代理”、GLOBAL。应用后重新打开 Clash，游戏匹配的进程直接联网，GitHub 等其他连接走全局模式原来选择的代理路线。

“遵循订阅规则”保留旧行为，不保证 GitHub 使用代理。清空软件选择时，“使用代理”仍保留默认代理规则；恢复原配置请点击“撤销本工具规则”。

升级保留同一应用数据目录及管理标记，可撤销旧版规则。订阅级扩展仍可能覆盖全局规则，实际连接需在 Clash 中确认。


面向普通用户的 **Clash Verge Rev 应用直连助手**。选择不使用代理的软件，识别相关进程，并生成程序路径直连规则。

独立第三方项目，与 Clash Verge Rev 官方没有隶属关系。

## 第一版功能

- Windows 软件扫描：开始菜单、桌面快捷方式、可读取路径的运行进程。
- 搜索、运行中筛选、已选择筛选，手动选择 `.exe` 添加。
- 自动关联：同产品信息的程序与少量已知软件的辅助程序，限制在程序所在目录下。
- 选择自动保存在本机；应用前再次扫描所选程序目录。
- `PROCESS-PATH,...,DIRECT` 规则使用完整路径，避免误匹配其他同名软件。
- 写入 Clash Verge Rev 的全局扩展脚本，保留已有 `function main(...)` 的返回结果。
- 规则备份、修改冲突检测、撤销本工具规则。
- MUI 统一组件及明暗主题。

## 当前验证状态

这是 v0.1.0 源码首版，尚未发布经过本机端到端验证的安装包。

创作环境不能下载 npm / Rust 依赖，且不能读取用户的 Clash 配置目录。因此已完成路由脚本测试、PowerShell 扫描器语法及模拟目录测试，但 **TypeScript 构建、Rust 编译、真实 Clash 应用和安装包运行仍需验证**。源码附带 GitHub Actions 构建流程。

## 技术栈

React 19 + TypeScript + MUI 7 + Vite + Tauri 2 + Rust。图标统一使用 `@mui/icons-material`。

### 浏览器预览

安装 Node.js 22 或更高版本，双击 `start-web-preview.cmd`。首次自动下载前端依赖，然后打开界面。

浏览器预览使用示例数据，不能扫描真实进程或修改 Clash。

### Windows 桌面运行

需要 Node.js、Rust stable（MSVC）、Visual Studio 2022 C++ Build Tools、Windows SDK 和 WebView2 Runtime。

Tauri 官方安装要求：https://v2.tauri.app/start/prerequisites/

环境安装完成后双击 `start-desktop.cmd`；打包双击 `build-windows.cmd`。

也可以运行：

```powershell
npm install
node scripts/generate-icon.mjs
npm run desktop
```

生成安装包：

```powershell
npm run desktop:build
```

安装包输出于 `src-tauri/target/release/bundle/nsis/`。便携程序是 `src-tauri/target/release/clash-app-bypass.exe`，需要系统已安装 WebView2。

### GitHub 自动构建

1. 创建你账号下的 `clash-app-bypass` 仓库。
2. 将本目录作为仓库根目录推送，包括 `.github/workflows/windows-build.yml`。
3. 在仓库 Actions 中运行 **Build Windows**，也会在推送 `main` 时自动执行。
4. 成功后下载 `clash-app-bypass-windows-x64` 构建产物。

首次构建生成依赖锁文件，并通过 `dependency-lockfiles` 产物交付。建议把锁文件加入仓库，后续将工作流中的 `npm install` 改为 `npm ci`。

```powershell
git init -b main
git add .
git commit -m "Initial Clash App Bypass desktop app"
git remote add origin https://github.com/frank-zhi-0804/clash-app-bypass.git
git push -u origin main
```

本项目尚未代你创建或推送远程仓库。不要将实际 Clash 配置、订阅、备份或个人应用清单提交到 GitHub。

## 使用

1. 打开桌面版，等待扫描；若自动检测失败，在设置中选择包含 `profiles.yaml` 的 Clash Verge Rev 配置目录。
2. 选择不使用代理的软件。展开关联清单查看识别结果。
3. 从系统托盘**完全退出 Clash Verge**，确保其内核也停止运行。
4. 点击“应用到 Clash”。工具只修改自己的全局扩展脚本尾部区段，不改订阅原文、不改代理节点。
5. 重新打开 Clash Verge，使用**规则模式**。需要接管不使用系统代理的应用时，在 Clash 中开启 TUN。
6. 在 Clash 的连接页面检查新的连接是否使用 `DIRECT`。

取消选择再应用，会移除对应的软件规则。清空选择时，“使用代理”保留默认代理路线；“遵循订阅规则”移除全部本工具规则。也可以点击“撤销本工具规则”，保留软件选择并移除本工具管理段。

## 关联边界

- 不承诺识别某个软件的全部进程。目录外共享服务、缺少路径权限的进程、便携软件位于公共目录、特殊启动器需要单独添加。
- 扫描最大目录深度为 3，最多访问 2000 个目录项；不跟随 junction / symlink。
- 通过文件版本 `ProductName` 与少量已知辅助程序名称判断关联，不会将同目录的所有 `.exe` 一律直连。
- 路径变化后需要重新添加；保存的旧路径在应用时会检查，失效则停止应用。
- 应用成功表示脚本已写入；不会伪称连接验证成功。已建立的连接可能继续使用原路线。
- 默认适配具有 `uid: Script` 的全局脚本结构；手写其他入口形式、脚本指向配置目录外等情况会停止操作。
- 全局脚本后还有订阅级扩展，订阅脚本可能覆盖规则或进程识别设置。请以最终配置与实际连接为准。
- 第一版修改规则需要退出并重启 Clash，没有实现实时刷新或后台自动更新规则。

## 数据和备份

应用数据通过 Tauri `app_data_dir` 保存在本机的 `io.clashappbypass.app` 数据目录，包含 `settings.json`、`ownership.json` 和 `backups/`。

本机记录和备份包含程序路径及原扩展脚本，不上传，也不要公开。首次改写前备份原脚本，每次写入前再次检查 Clash 进程和源文件内容。规则区段若被外部修改或缺少本机归属记录，工具会停止修改。

若不能正常撤销：退出 Clash，在本机应用数据目录找到修改前备份，通过 Clash 的全局扩展脚本编辑器检查并恢复。不要在其他规则发生变化后盲目恢复整份旧脚本。

## 验证

```powershell
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File tests/scanner.test.ps1
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

## 后续计划

真实连接验证、更多软件关联清单、软件图标提取、配置刷新机制和更完整的端到端测试。

项目代码原创编写，未复制 Clash Verge Rev 或其他应用分流工具的源码。采用 MIT 开源许可证，见 LICENSE。

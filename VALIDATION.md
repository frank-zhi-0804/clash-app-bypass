# v0.1.0 验证记录

日期：2026-10-07

## 已通过

- `node --test tests/*.test.mjs`：5 项测试通过。
  - 程序直连规则先于原有 MATCH 规则。
  - 保留原脚本返回值、参数与其他配置字段。
  - 同一配置反复处理不会重复添加规则。
  - 原脚本返回无效值或 Promise 时明确报错。
  - 路径通过 JSON 序列化，不会被解释成 JavaScript。
- Windows PowerShell 5.1 `tests/scanner.test.ps1`：模拟应用目录测试通过。
  - 主程序运行状态识别。
  - 未运行的已知辅助程序从磁盘发现。
  - 同目录无关 `.exe` 不关联。
  - 目录外的同名辅助程序不关联。
- JSON 配置解析通过。
- Windows 启动器 PowerShell 语法检查通过。
- 图标生成器和管理脚本 JavaScript 语法检查通过。

## 未完成

环境拒绝 npm 网络请求及 Rust 工具链下载（EACCES / Windows socket error 10013）。此外，无法读取用户的实际 Clash 配置目录。

以下未执行，不能视为通过：

- `npm run build`：TypeScript 类型检查与 MUI 前端生产构建。
- `cargo test`：Rust 规则区段、文件归属及原子替换测试。
- `npm run desktop:build`：Windows 安装包构建。
- 真实桌面扫描、连接用户 Clash、应用和撤销。
- 实际流量验证、安装器及界面视觉检查。

## 在发布前继续验证

附带的 GitHub Actions 会执行前端构建、脚本测试、Rust 测试和桌面打包。构建成功后仍需要在 Windows 上验证：

1. 运行 Clash 时应用操作被阻止。
2. 退出 Clash 后，既有全局 main 正常执行且规则仅添加一份。
3. 重启 Clash，在规则模式下，新连接命中 DIRECT。
4. 取消选择、再次应用和撤销不会删除其他规则。
5. 修改工具管理段后，冲突检测阻止覆盖。
6. 明暗主题、搜索、程序选择和错误提示正常显示。

当前状态：源码首版，尚未经过编译和端到端运行验证。

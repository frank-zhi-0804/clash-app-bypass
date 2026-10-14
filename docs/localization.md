# Localization / 国际化维护

The interface uses i18next and react-i18next with bundled Chinese and English resources. No network translation, language-detection service, or additional settings store is required.

界面使用 i18next / react-i18next 和本地打包的中英文资源。无需在线翻译、语言检测服务或额外的设置存储。

## Adding text / 新增文案

- Use stable semantic keys in `src/locales/`, never the displayed sentence as an identifier. Add both languages together. / 使用稳定语义键，不以显示文案作标识；两种语言同时补齐。
- Interpolate named values such as `count`, `path`, and `domain`; write complete sentences instead of concatenating translated fragments. Provide English singular/plural variants for count-dependent messages. / 使用命名插值，翻译完整句子，数量文案提供英文单复数。
- Store message descriptors in asynchronous UI state and render them in the current language. Do not cache translated strings in result, error, or notification state. / 异步状态保存消息描述符，显示时按当前语言翻译，避免切换后残留旧语言。
- Backend responses use stable message keys and parameters. Keep raw system errors as diagnostic details; never infer message identity by matching Chinese prose. / 后端返回稳定消息键和参数，系统错误作为原始诊断细节保留，不按中文正文猜测消息类型。
- Translate labels, helper text, dialogs, tooltips, and accessibility names. Preserve user data such as application names, file paths, domains, and proxy group names. / 翻译标签、帮助、对话框、提示与无障碍名称，保留应用名称、路径、域名、代理组等用户数据。

## Preferences and routing / 偏好与分流

`settings.json` stores `language` as `zh-CN` or `en`; missing or unsupported preferences fall back to Chinese. Keep language outside `routingFingerprint`. Switching language must not resume undone routing, clear a routing failure, or call `apply_rules`/`remove_rules` merely to update text.

`settings.json` 的 `language` 为 `zh-CN` 或 `en`，缺失或不支持时回退中文。语言不参与 `routingFingerprint`；切换语言不能恢复已撤销的规则、清除分流错误，也不能为了更新显示调用规则写入或撤销。

## Verification / 验证

Run `npm test` and `npm run build`; the localization checks compare key coverage and interpolation parameters, exercise fallback and plural forms, and protect routing invariants. Rust tests cover backward-compatible settings and structured messages. Check both languages in application, website, and settings pages, including delayed responses, failures, undo, relaunch, and a narrow window.

运行 `npm test` 和 `npm run build`；国际化测试检查翻译键、插值参数、回退、复数和分流状态。Rust 测试覆盖旧设置兼容与消息结构。两种语言均检查应用、网站、设置、延迟返回、失败、撤销、重开及窄窗口。

## Resource layout / 资源位置

`src/locales/zh-CN.ts` defines frontend keys and `en.ts` must implement the same keys. `src/locales/backend.zh-CN.json` and `backend.en.json` contain stable backend keys. `src/messages.ts` handles descriptors; `src/i18n.ts` renders them. Rust `src-tauri/src/messages.rs` provides the IPC contract and renders the Chinese compatibility metadata from the bundled catalog.

前端语义键由 `src/locales/zh-CN.ts` 定义，`en.ts` 必须完整实现；后端键位于 `backend.zh-CN.json` / `backend.en.json`。消息结构由 `src/messages.ts` 处理，显示由 `src/i18n.ts` 负责，Rust IPC 契约位于 `src-tauri/src/messages.rs`。

App entries retain string `source` and `warnings` fields for older binaries. The current UI prefers `sourceMessage` and `warningMessages` descriptors after scanning. If a legacy entry cannot be refreshed, its historical metadata remains in its original language; do not guess translations from the prose.

应用条目的 `source` / `warnings` 保持字符串兼容旧版，扫描后优先使用新增的 `sourceMessage` / `warningMessages`。旧条目无法刷新时保留历史信息的原语言，不按正文猜译。

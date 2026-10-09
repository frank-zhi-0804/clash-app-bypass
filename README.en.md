<p align="center"><img src="app-icon.png" width="128" alt="Clash App Bypass icon" /></p>

# Clash App Bypass

[中文](README.md) | **English**

A Windows application bypass assistant for Clash Verge Rev. Select applications that should connect directly, inspect related processes, and generate rules matching their full executable paths. This is an independent third-party project, unaffiliated with Clash Verge Rev. Current source version: **0.1.5**. The application interface is currently in Chinese.

## Features

- VALORANT WeGame launchers associate the game executables, login launcher, and known network helpers within the same installation, covering executable paths outside the launcher directory.
- Scan Start Menu and desktop shortcuts and running processes with readable paths; manually add `.exe` files.
- Search applications, filter running or selected entries, and inspect related processes.
- Associate executables in the application's directory using product metadata and a small list of known helper names.
- Save selections locally; rescan and validate executable paths before applying changes.
- Generate `PROCESS-PATH,...,DIRECT` rules to avoid matching unrelated executables with the same name.
- Manage a dedicated section of the global extension script with backups, conflict detection, and undo.
- Light and dark themes; application icons generated from the root `app-icon.png` artwork.

## Download

Download the latest published version from [GitHub Releases](https://github.com/frank-zhi-0804/clash-app-bypass/releases/latest). Choose the EXE containing `setup` for installation, or portable `clash-app-bypass.exe`. The portable executable requires WebView2 Runtime. `SHA256SUMS.txt` contains download checksums.

The author has confirmed that the published v0.1.1 works on their own Windows computer. Builds of newer source changes are available as `clash-app-bypass-windows-x64` artifacts from successful [GitHub Actions](https://github.com/frank-zhi-0804/clash-app-bypass/actions/workflows/windows-build.yml) runs. Releases remain the source for published versions.

## Improvements in 0.1.2

- Startup scanning and Clash detection handle failures independently, with initialization and scan retries.
- Refreshing or applying removes missing helper paths. Missing main executables remain selected with instructions to re-add them.
- Associate QQ's `QQEX.exe` and WeGame's `qbblinktrial\browser.exe`. Written bypass rules do not require the assistant to remain open.
- Explicit saved-but-not-applied, rules-written, and restart-pending states. Theme changes do not mark routing as changed.
- After restarting Clash, click the status-check button or rescan. These states describe configuration progress; inspect actual routes in Clash.

## Usage

1. Open the desktop app and wait for scanning. If automatic detection fails, select the Clash Verge Rev configuration folder containing `profiles.yaml` in Settings (`设置`).
2. Enable “Do not use proxy” (`不使用代理`) for applications that should connect directly. Expand each entry to review associated processes.
3. Configure “Other traffic” (`其他流量`). The default is “Use proxy” (`使用代理`) with the `GLOBAL` group. Ensure that group ultimately selects a working proxy rather than `DIRECT`.
4. **Fully exit Clash Verge Rev from the system tray**, including its core.
5. Click “Apply to Clash” (`应用到 Clash`), reopen Clash Verge Rev, and use **Rule mode**. Enable TUN if you need to capture applications that ignore the system proxy.
6. Inspect new connections in Clash to confirm `DIRECT` for selected applications and the expected proxy for other traffic.

The default rule order is “selected executable paths → DIRECT; remaining traffic → MATCH,selected proxy group”. This overrides subscription routing rules in the runtime configuration while preserving the subscription source and original script. “Follow subscription rules” (`遵循订阅规则`) retains subscription routing and does not guarantee that a particular website uses a proxy.

Deselect an application and apply again to remove its direct rules. With no applications selected, “Use proxy” still retains the default proxy rule. “Undo this tool's rules” (`撤销本工具规则`) removes the managed section while keeping application selections.

## Scope and limitations

- Windows only. Browser preview uses sample data and cannot scan real applications or modify Clash.
- Association does not guarantee every related process is found. Shared services outside the application directory, special launchers, and processes with unreadable paths may need manual addition.
- Directory scanning is limited to depth 3 and 2,000 entries and does not follow junctions or symlinks. It does not bypass every `.exe` in a directory automatically.
- Re-add applications when the main executable path changes. Missing helper paths are removed before refresh or application; existing historical helper paths are retained.
- The integration expects the global script structure with `uid: Script`. Unsupported entry points or scripts outside the configuration directory cause the operation to stop.
- Subscription extensions can override global rules or process detection settings. Check the final configuration and actual connections.
- Successful application means the script was written. Existing connections may keep their previous route. Exiting and restarting Clash is required; live refresh and background rule updates are not implemented.

## Local data, backups, and undo

Tauri's `app_data_dir` (application identifier `io.clashappbypass.app`) stores `settings.json`, `ownership.json`, and `backups/`. These contain executable paths and original extension scripts. The tool does not upload them; do not commit them to a public repository.

The original script is backed up before the first modification. Clash processes and source contents are checked before every write. External edits to the managed section or missing local ownership records stop modifications. Upgrades use the same data directory and management markers.

If undo fails, exit Clash, locate a backup in the local data directory, and review and restore it through Clash's global extension script editor. Avoid overwriting the entire script with an old backup if other rules have changed.

## Development and builds

Install Node.js 22 or later. Desktop development also requires stable Rust (MSVC), Visual Studio C++ Build Tools, Windows SDK, and WebView2. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```powershell
npm install
node scripts/generate-icon.mjs
npm run dev           # Browser preview
npm run desktop       # Desktop development
npm run desktop:build # Windows installer
```

Alternatively, run `start-web-preview.cmd`, `start-desktop.cmd`, or `build-windows.cmd`. These launchers install missing frontend dependencies and generate icons. Generate icons before invoking a desktop build directly. Installers are written to `src-tauri/target/release/bundle/nsis/`; the portable executable is `src-tauri/target/release/clash-app-bypass.exe`.

### Icons

`app-icon.png` is the source artwork. `node scripts/generate-icon.mjs` uses the local Tauri CLI to generate desktop assets in `src-tauri/icons/` and copies the 128-pixel version to `public/app-icon.png` for the sidebar and browser favicon. Run it again after replacing the source image.

### Validation

```powershell
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File tests/scanner.test.ps1
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

The [Build Windows workflow](.github/workflows/windows-build.yml) runs on pushes to `main`, `v*` tags, and pull requests, and supports manual dispatch. It checks routing rules, the scanner, frontend, and Rust backend, then packages and uploads Windows artifacts and dependency lock files. It does not automatically create a GitHub Release.

The author has run and verified the published v0.1.1 on Windows. CI checks routing, the scanner, frontend, and Rust backend and packages the installer.

## License

[MIT](LICENSE). The project code was independently written without copying source from Clash Verge Rev or other application routing tools.

## Association and live routing checks (0.1.4)

Startup and rescanning refresh selected applications. In addition to known helpers, the current process ancestry supplies candidate executables for review. Confirm a candidate and reapply the rules to include it; applications opened by a launcher are not silently bypassed.

Open the selected application and create new connections, then click the live connection check button. Diagnostics only read the local named-pipe Clash API from the selected configuration directory, without changing modes, interfaces, rules, or permissions. TCP-only controllers are not supported for diagnostics. Results distinguish missing loaded rules, incorrect routing mode, proxy traffic, rejected connections, observed direct traffic, and no observable traffic. Connections without process paths are reported separately. Snapshots include existing connections and cannot guarantee complete process discovery; exited launchers, protected processes, or unknown installation layouts may still require manual additions.

## Automatic operation (0.1.5)

Enabling app bypass automatically saves and attempts to apply rules online, without exiting Clash when successful, and enables rule mode. While open, the assistant refreshes selected executables, includes known helpers, and checks connections and loaded rules approximately 30 seconds after each completed cycle. Closing it stops monitoring; no resident service is installed and persistent rules remain. Startup-chain candidates with matching product metadata and the same valid signing certificate can be included automatically; other candidates require confirmation.

Online updates use the existing local named-pipe interface without enabling interfaces or changing permissions. The assistant checks existing rules and network settings, backs up and updates the global script and runtime configuration, reloads, and verifies. Failures attempt restoration; external changes preserve the conflict and stop automatic retries. If Clash is stopped, rules are saved for its next startup. Returning from older proxy-fallback rules to subscription routing, or fully removing them without the original subscription rules, requires a one-time offline operation.

Diagnostics are a current snapshot, do not terminate existing connections, and cannot guarantee discovery of all unknown or protected processes. Healthy operation does not repeatedly show popups; immediate checks and manual retries remain available.

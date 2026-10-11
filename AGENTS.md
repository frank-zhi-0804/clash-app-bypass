# Project workflow

- After each complete requested change, run relevant checks, commit only files belonging to that change, push to GitHub, and check the associated Actions build. The user has authorized this workflow.
- Include a clear description with every GitHub push: use descriptive commit subjects and bodies explaining the behavior, validation, and the previous working commit for rollback. Keep feature changes in their own commits and document notable changes in CHANGELOG.md.
- Preserve unrelated local files and patches. Never force-push or move an existing release tag.
- Keep package.json, the npm lockfile, Cargo.toml, tauri.conf.json, and the displayed application version consistent when changing versions.
- Keep Chinese and English README content aligned. Describe only verified behavior and distinguish saved selections, written rules, and observed Clash restart.
- Create a version tag and GitHub Release only when the user requests publication; use artifacts from the successful build of that exact commit.
- After each validated application update, replace the user's existing local app with the new build and create or refresh its desktop shortcut. The user authorizes removing superseded app executables; preserve application settings, source files, unrelated apps, and uninstall support. Verify the new version and shortcut target before removing old test copies. Do not leave the desktop shortcut pointing to a temporary build directory.

# Project workflow

- After each complete requested change, run relevant checks, commit only files belonging to that change, push to GitHub, and check the associated Actions build. The user has authorized this workflow.
- Preserve unrelated local files and patches. Never force-push or move an existing release tag.
- Keep package.json, the npm lockfile, Cargo.toml, tauri.conf.json, and the displayed application version consistent when changing versions.
- Keep Chinese and English README content aligned. Describe only verified behavior and distinguish saved selections, written rules, and observed Clash restart.
- Create a version tag and GitHub Release only when the user requests publication; use artifacts from the successful build of that exact commit.

// Generate desktop and browser icons from the project's original artwork.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'clash-app-bypass-icons-'));
try {
  const result = spawnSync(process.execPath, [cli, 'icon', 'app-icon.png', '--output', output], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Icon generation failed (${result.status}).`);
  fs.mkdirSync(new URL('../src-tauri/icons/', import.meta.url), { recursive: true });
  for (const name of ['icon.png', 'icon.ico']) {
    fs.copyFileSync(path.join(output, name), new URL(`../src-tauri/icons/${name}`, import.meta.url));
  }
  fs.mkdirSync(new URL('../public/', import.meta.url), { recursive: true });
  fs.copyFileSync(path.join(output, '128x128.png'), new URL('../public/app-icon.png', import.meta.url));
} finally {
  fs.rmSync(output, { recursive: true, force: true });
}
console.log('Application icons generated from app-icon.png.');

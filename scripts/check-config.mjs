import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

for (const path of ['.github/workflows/ci.yml', '.github/workflows/deploy-worker.yml']) {
  const workflow = parseYaml(readFileSync(path, 'utf8'));
  if (!workflow || typeof workflow !== 'object' || !workflow.jobs || !workflow.on) {
    throw new Error(`invalid GitHub Actions workflow: ${path}`);
  }
  console.log(`workflow yaml ok: ${path}`);
}

const manifest = JSON.parse(readFileSync('manifest.webmanifest', 'utf8'));
if (!manifest.name || !manifest.start_url || !Array.isArray(manifest.icons) || manifest.icons.length < 2) {
  throw new Error('manifest.webmanifest is missing required app metadata');
}
for (const icon of manifest.icons) {
  if (!existsSync(icon.src)) throw new Error(`manifest icon is missing: ${icon.src}`);
}
console.log('manifest ok');

const serviceWorker = readFileSync('sw.js', 'utf8');
const shellBlock = serviceWorker.match(/const APP_SHELL = \[([\s\S]*?)\];/)?.[1] || '';
const shellPaths = [...shellBlock.matchAll(/'([^']+)'/g)].map(match => match[1]);
if (!shellPaths.length) throw new Error('Service Worker app shell is empty');
for (const shellPath of shellPaths) {
  if (shellPath === './') continue;
  const filePath = shellPath.replace(/^\.\//, '');
  if (!existsSync(filePath)) throw new Error(`Service Worker app shell file is missing: ${shellPath}`);
}
console.log(`service worker shell ok: ${shellPaths.length} entries`);

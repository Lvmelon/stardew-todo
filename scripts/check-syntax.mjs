import { readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('../', import.meta.url);
const IGNORED = new Set(['.git', 'node_modules', 'worker']);

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(fullPath));
    else if (extname(entry.name) === '.js') files.push(fullPath);
  }
  return files;
}

const rootPath = decodeURIComponent(ROOT.pathname).replace(/^\/(.:)/, '$1');
const files = await collect(rootPath);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exitCode = 1;
  } else {
    process.stdout.write(`syntax ok: ${relative(rootPath, file)}\n`);
  }
}

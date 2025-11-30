import { mkdir, readdir, copyFile, rm, stat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resolve = (...segments) => path.join(__dirname, '..', ...segments);
const nodeProjectRoot = resolve('nodejs-assets', 'nodejs-project');
const source = nodeProjectRoot;
const destination = resolve('public', 'nodejs-project');

async function copyDirectory(src, dest) {
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
}

async function ensureNodeDependencies() {
  const diodeModule = path.join(nodeProjectRoot, 'node_modules', 'diodejs', 'package.json');
  try {
    await stat(diodeModule);
    return;
  } catch (_) {
    console.log('Installing Node runtime dependencies...');
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npmCmd, ['install', '--omit=dev'], {
      cwd: nodeProjectRoot,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      throw new Error('Failed to install Node runtime dependencies');
    }
  }
}

async function patchColorspace(baseDir) {
  const file = path.join(
    baseDir,
    'node_modules',
    '@so-ric',
    'colorspace',
    'dist',
    'index.cjs.js'
  );
  try {
    let contents = await readFile(file, 'utf8');
    const target = '(limiters[m] ||= [])[channel] = modifier;';
    if (contents.includes(target)) {
      const replacement = [
        '    if (!limiters[m]) {',
        '      limiters[m] = [];',
        '    }',
        '',
        '    limiters[m][channel] = modifier;'
      ].join('\n');
      contents = contents.replace(target, replacement);
    }

    const hasOwnTarget = 'Object.hasOwn(cssKeywords, name)';
    const hasOwnReplacement = 'Object.prototype.hasOwnProperty.call(cssKeywords, name)';
    if (contents.includes(hasOwnTarget)) {
      contents = contents.replace(hasOwnTarget, hasOwnReplacement);
    }

    await writeFile(file, contents, 'utf8');
    console.log('Patched colorspace module for legacy Node runtime.');
  } catch (err) {
    console.warn(`Unable to patch colorspace module at ${file}: ${err.message}`);
  }
}

async function main() {
  await ensureNodeDependencies();
  await patchColorspace(nodeProjectRoot);
  console.log(`Syncing NodeJS assets from ${source} -> ${destination}`);
  await rm(destination, { recursive: true, force: true });
  await copyDirectory(source, destination);
  console.log('Node assets synced.');
}

main().catch((err) => {
  console.error('Failed to sync node assets', err);
  process.exit(1);
});

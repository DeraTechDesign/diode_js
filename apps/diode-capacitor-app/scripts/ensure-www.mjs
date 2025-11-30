import { mkdir, readdir, copyFile, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const androidDir = path.join(__dirname, '..', 'android');
const androidAssetsDir = path.join(androidDir, 'app', 'src', 'main', 'assets');
const source = path.join(androidAssetsDir, 'public');
const destinations = [
  path.join(androidAssetsDir, 'www'),
  path.join(androidDir, 'capacitor-cordova-android-plugins', 'src', 'main', 'assets', 'www'),
];
const cordovaLibSource = path.join(androidDir, 'capacitor-cordova-android-plugins', 'src', 'main', 'libs', 'cdvnodejsmobile');
const nodeLibTargets = [
  path.join(androidDir, 'app', 'libs', 'cdvnodejsmobile'),
  path.join(androidDir, 'capacitor-cordova-android-plugins', 'libs', 'cdvnodejsmobile'),
];
const pluginLibnodeSource = path.join(__dirname, '..', 'node_modules', 'nodejs-mobile-cordova', 'libs', 'android', 'libnode');
const builtinAssetsSource = path.join(__dirname, '..', 'node_modules', 'nodejs-mobile-cordova', 'install', 'nodejs-mobile-cordova-assets');
const builtinAssetsTargets = [
  path.join(androidAssetsDir, 'nodejs-mobile-cordova-assets'),
  path.join(androidDir, 'capacitor-cordova-android-plugins', 'src', 'main', 'assets', 'nodejs-mobile-cordova-assets'),
];

async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
}

async function decompressLibs(libnodeDir) {
  const binDir = path.join(libnodeDir, 'bin');
  let entries;
  try {
    entries = await readdir(binDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const archBinDir = path.join(binDir, entry.name);
    const gzipPath = path.join(archBinDir, 'libnode.so.gz');
    const targetPath = path.join(archBinDir, 'libnode.so');
    try {
      await stat(gzipPath);
    } catch {
      continue;
    }

    await new Promise((resolve, reject) => {
      const gunzip = createGunzip();
      const stream = createReadStream(gzipPath).pipe(gunzip).pipe(createWriteStream(targetPath));
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
    await rm(gzipPath, { force: true });
    const libnodeTarget = path.join(libnodeDir, 'bin', entry.name);
    await mkdir(libnodeTarget, { recursive: true });
    await copyFile(targetPath, path.join(libnodeTarget, 'libnode.so'));
  }
}

async function main() {
  try {
    await stat(source);
  } catch (err) {
    console.error(`Source assets folder not found: ${source}`);
    process.exit(1);
  }

  for (const destination of destinations) {
    await rm(destination, { recursive: true, force: true });
    await copyDir(source, destination);
    console.log(`Copied ${source} -> ${destination}`);
  }

  for (const nodeLibDest of nodeLibTargets) {
    try {
      await stat(cordovaLibSource);
      await rm(nodeLibDest, { recursive: true, force: true });
      await copyDir(cordovaLibSource, nodeLibDest);
      await copyDir(pluginLibnodeSource, path.join(nodeLibDest, 'libnode'));
      await decompressLibs(path.join(nodeLibDest, 'libnode'));
      console.log(`Synced native libs into ${nodeLibDest}`);
    } catch (err) {
      console.warn(`NodeJS Mobile libs not found: ${err.message}`);
    }
  }

  for (const target of builtinAssetsTargets) {
    try {
      await stat(builtinAssetsSource);
      await rm(target, { recursive: true, force: true });
      await copyDir(builtinAssetsSource, target);
      console.log(`Mirrored nodejs-mobile assets into ${target}`);
    } catch (err) {
      console.warn(`Failed copying builtin assets to ${target}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error('Failed to mirror web assets for Cordova compatibility', err);
  process.exit(1);
});

#!/usr/bin/env fibjs

import { build } from 'esbuild';
import { createBuildConfig } from './build-config.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const shouldZip = process.argv.includes('--zip');
const buildSeqPath = path.join(projectRoot, '.chrome-build-seq.json');

function nextBuildNumber(version) {
  const raw = fs.existsSync(buildSeqPath)
    ? JSON.parse(fs.readFileSync(buildSeqPath, 'utf8'))
    : null;
  const previousVersion = typeof raw?.version === 'string' ? raw.version : null;
  const previousBuildNumber = Number.isInteger(raw?.buildNumber) ? raw.buildNumber : 0;
  const buildNumber = previousVersion === version ? previousBuildNumber + 1 : 1;

  if (buildNumber > 65535) {
    throw new Error(`Build number overflow for ${version}; got ${buildNumber}`);
  }

  fs.writeFileSync(
    buildSeqPath,
    JSON.stringify({ version, buildNumber }, null, 2) + '\n',
    'utf8'
  );

  return buildNumber;
}

/**
 * Sync version from package.json to manifest.json
 * @returns {string} Current version
 */
function syncVersion() {
  const packagePath = path.join(projectRoot, 'package.json');
  const manifestPath = path.join(__dirname, 'manifest.json');
  
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  
  if (manifest.version !== packageJson.version) {
    manifest.version = packageJson.version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`  • Updated manifest.json version`);
  }
  return packageJson.version;
}

/**
 * Check for missing translation keys
 */
async function checkMissingKeys() {
  console.log('📦 Checking translations...');
  try {
    await import('../scripts/check-missing-keys.js');
  } catch (error) {
    console.error('⚠️  Warning: Failed to check translation keys:', error.message);
  }
}

function writeBuildInfo(outdir, version, buildNumber) {
  const buildInfoPath = path.join(outdir, 'build-info.json');
  const manifestVersion = `${version}.${buildNumber}`;
  const buildInfo = {
    version,
    buildNumber,
    manifestVersion,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2) + '\n', 'utf8');
  console.log(`  • build-info.json (${buildInfo.manifestVersion})`);
  return buildInfo;
}

// Production build
const version = syncVersion();
console.log(`🔨 Building Chrome Extension... v${version}\n`);

try {
  // Sync supported formats
  const { default: syncFormats } = await import('../scripts/sync-formats.js');
  syncFormats();

  // Check translations
  await checkMissingKeys();

  // Clean dist/chrome to avoid stale artifacts.
  const outdir = path.join(projectRoot, 'dist/chrome');
  if (fs.existsSync(outdir)) {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
  
  // Change to project root for esbuild to work correctly
  process.chdir(projectRoot);
  
  const config = createBuildConfig();
  await build(config);
  
  // Copy LICENSE
  const licenseSrc = path.join(projectRoot, 'LICENSE');
  if (fs.existsSync(licenseSrc)) {
    fs.copyFileSync(licenseSrc, path.join(outdir, 'LICENSE'));
    console.log('  • LICENSE');
  }
  const buildNumber = nextBuildNumber(version);
  const distManifestPath = path.join(outdir, 'manifest.json');
  const distManifest = JSON.parse(fs.readFileSync(distManifestPath, 'utf8'));
  distManifest.version = `${version}.${buildNumber}`;
  fs.writeFileSync(distManifestPath, JSON.stringify(distManifest, null, 2) + '\n', 'utf8');
  console.log(`  • manifest.json version ${distManifest.version}`);

  const buildInfo = writeBuildInfo(outdir, version, buildNumber);

  console.log(`\n✅ Build complete!`);
  console.log(`   Output: dist/chrome/`);
  console.log(`   Version: ${buildInfo.manifestVersion}`);

  if (shouldZip) {
    const zipPath = path.join(projectRoot, 'dist', `chrome-v${version}.zip`);
    console.log('\n📦 Creating ZIP package...');

    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    execSync(`cd "${outdir}" && zip -r "${zipPath}" .`, { stdio: 'ignore' });

    const zipStats = fs.statSync(zipPath);
    const zipSize = zipStats.size >= 1024 * 1024
      ? `${(zipStats.size / 1024 / 1024).toFixed(2)} MB`
      : `${(zipStats.size / 1024).toFixed(2)} KB`;
    console.log(`   Package: dist/chrome-v${version}.zip`);
    console.log(`   Size: ${zipSize}`);
  }
} catch (error) {
  console.error('❌ Build failed:', error);
  process.exit(1);
}

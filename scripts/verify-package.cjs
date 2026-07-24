const { spawnSync } = require('node:child_process');
const { lstatSync, readFileSync } = require('node:fs');
const { extname, resolve } = require('node:path');

const REQUIRED_FILES = Object.freeze([
  'package.json',
  'README.md',
  'LICENSE',
  'out/extension.js',
]);
const ALLOWED_ROOT_FILES = new Set(REQUIRED_FILES);
const SAFE_ASSET_PATH = /^assets\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\.(?:png|jpe?g|gif|webp)$/;

function isAllowedPackagePath(file) {
  if (
    typeof file !== 'string' ||
    file.length === 0 ||
    file.includes('\\') ||
    file.includes('\0') ||
    file.startsWith('/') ||
    /^[a-z]:/i.test(file)
  ) {
    return false;
  }

  const segments = file.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false;
  }

  return ALLOWED_ROOT_FILES.has(file) || SAFE_ASSET_PATH.test(file);
}

function hasExpectedImageSignature(file) {
  const absoluteFile = resolve(__dirname, '..', file);
  const stat = lstatSync(absoluteFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return false;
  }

  const bytes = readFileSync(absoluteFile);
  const extension = extname(file);
  if (extension === '.png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (extension === '.gif') {
    const header = bytes.subarray(0, 6).toString('ascii');
    return header === 'GIF87a' || header === 'GIF89a';
  }
  if (extension === '.webp') {
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  return false;
}

function verifyPackageFiles(files) {
  const errors = [];
  const duplicates = files.filter((file, index) => files.indexOf(file) !== index);
  if (duplicates.length > 0) {
    errors.push(`duplicate paths:\n${[...new Set(duplicates)].join('\n')}`);
  }

  const unexpected = files.filter((file) => !isAllowedPackagePath(file));
  if (unexpected.length > 0) {
    errors.push(`unexpected paths:\n${unexpected.join('\n')}`);
  }

  const missing = REQUIRED_FILES.filter((file) => !files.includes(file));
  if (missing.length > 0) {
    errors.push(`missing required paths:\n${missing.join('\n')}`);
  }

  const executableBundles = files.filter((file) => file === 'out/extension.js');
  if (executableBundles.length !== 1) {
    errors.push(`expected exactly one out/extension.js entry; found ${executableBundles.length}`);
  }

  for (const file of files.filter((entry) => SAFE_ASSET_PATH.test(entry))) {
    try {
      if (!hasExpectedImageSignature(file)) {
        errors.push(`asset is not a regular image of the declared type: ${file}`);
      }
    } catch (error) {
      errors.push(`could not validate asset ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return errors;
}

function main() {
  const vsceCli = require.resolve('@vscode/vsce/vsce');
  const result = spawnSync(
    process.execPath,
    [vsceCli, 'ls', '--no-yarn', '--no-dependencies'],
    { encoding: 'utf8' }
  );

  if (result.error || result.status !== 0) {
    console.error(result.error?.message || result.stderr.trim() || 'Could not inspect VSIX contents.');
    process.exitCode = result.status || 1;
    return;
  }

  const files = result.stdout
    .split(/\r?\n/)
    .filter((entry) => entry.length > 0);
  const errors = verifyPackageFiles(files);
  if (errors.length > 0) {
    console.error(`VSIX package boundary verification failed:\n${errors.join('\n\n')}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Verified VSIX allowlist: ${files.length} files, ${files.length - REQUIRED_FILES.length} safe image assets, one executable bundle.`
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  isAllowedPackagePath,
  verifyPackageFiles,
};

const { spawnSync } = require('node:child_process');
const packageJson = require('../package.json');

const extensionId = `${packageJson.publisher}.${packageJson.name}`.toLowerCase();
const expectedEntry = `${extensionId}@${packageJson.version}`;
const codeCli = process.env.CODE_CLI || 'code';
const result = spawnSync(codeCli, ['--list-extensions', '--show-versions'], {
  encoding: 'utf8',
});

if (result.error) {
  console.error(`Could not run ${codeCli}: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(result.stderr.trim() || `${codeCli} exited with status ${result.status}`);
  process.exit(result.status || 1);
}

const installedEntry = result.stdout
  .split(/\r?\n/)
  .map((entry) => entry.trim().toLowerCase())
  .find((entry) => entry.startsWith(`${extensionId}@`));

if (installedEntry !== expectedEntry) {
  console.error(
    `Installed extension mismatch: expected ${expectedEntry}, found ${installedEntry || 'not installed'}.`
  );
  process.exit(1);
}

console.log(`Verified installed extension: ${expectedEntry}`);

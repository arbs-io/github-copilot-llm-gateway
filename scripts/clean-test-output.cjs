const fs = require('node:fs');
const path = require('node:path');

fs.rmSync(path.join(__dirname, '..', 'out-test'), { recursive: true, force: true });

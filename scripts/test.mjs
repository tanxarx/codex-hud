import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['tests/unit', 'tests/integration'].flatMap(directory =>
  readdirSync(new URL(`../${directory}/`, import.meta.url))
    .filter(file => file.endsWith('.mjs')).sort().map(file => `${directory}/${file}`));
// macOS aliases /var and /tmp; existing path assertions need the canonical root.
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: realpathSync(tmpdir()) },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);

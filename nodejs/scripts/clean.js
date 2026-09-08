import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

rmSync(resolve(pkgRoot, 'dist'), { recursive: true, force: true });
console.log('[query-sign] cleaned dist/');

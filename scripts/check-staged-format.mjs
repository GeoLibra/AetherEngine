import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const files = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
  encoding: 'utf8'
})
  .split('\n')
  .filter((file) => /\.(json|md|mjs|ts|tsx|yaml|yml)$/.test(file));

if (files.length === 0) process.exit(0);

const prettier = join(process.cwd(), 'node_modules', 'prettier', 'bin', 'prettier.cjs');
if (!existsSync(prettier)) {
  console.error('Prettier is not installed. Run: pnpm install');
  process.exit(1);
}

try {
  execFileSync(process.execPath, [prettier, '--check', ...files], { stdio: 'inherit' });
} catch {
  process.exit(1);
}

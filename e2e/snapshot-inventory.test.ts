import { readdirSync } from 'node:fs';
import { expect, test } from 'vitest';

// Both CI operating systems execute the same rendered scenarios. A new golden must
// include both baselines before merge; a local macOS run alone cannot establish coverage.
test('ships matching Linux and macOS baselines for every browser screenshot', () => {
  const specs = new URL('./specs/', import.meta.url);
  const missing: string[] = [];
  for (const directory of readdirSync(specs).filter((name) => name.endsWith('-snapshots'))) {
    const files = new Set(readdirSync(new URL(`${directory}/`, specs)));
    for (const file of files) {
      if (!/-(darwin|linux)\.png$/.test(file)) continue;
      const counterpart = file.endsWith('-darwin.png')
        ? file.replace(/-darwin\.png$/, '-linux.png')
        : file.replace(/-linux\.png$/, '-darwin.png');
      if (!files.has(counterpart)) missing.push(`${directory}/${counterpart}`);
    }
  }
  expect(missing, 'Missing platform-specific browser goldens').toEqual([]);
});

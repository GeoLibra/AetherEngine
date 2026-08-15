import { auditProductionFreeze } from './object-freeze-analysis.mjs';

try {
  process.stdout.write(`${JSON.stringify(auditProductionFreeze(), null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `Object.freeze audit failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BenchmarkReport } from './types';

export function writeArtifact(report: BenchmarkReport, directory: string): string {
  mkdirSync(directory, { recursive: true });
  const timestamp = report.createdAt.replaceAll(':', '-');
  const path = resolve(directory, `ecs-${report.profile}-${timestamp}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}

export function printReport(report: BenchmarkReport, artifactPath: string): void {
  const supported = report.results.filter((result) => result.status === 'supported');
  const unsupported = report.results.length - supported.length;
  process.stdout.write(
    `ECS benchmark ${report.profile}: ${supported.length} supported, ${unsupported} unsupported\n`
  );
  for (const result of supported) {
    process.stdout.write(
      `${result.request.scenarioId}/${result.request.subjectId}/${result.request.input.caseId} median=${result.summary.median.toFixed(3)}ms p95=${result.summary.p95.toFixed(3)}ms\n`
    );
  }
  process.stdout.write(`Artifact: ${artifactPath}\n`);
}

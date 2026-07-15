import { formatWorkerResult } from './harness/child-process';
import { executeCase } from './harness/worker-runner';
import type { BenchmarkCaseRequest } from './harness/types';

const encoded = process.argv[2];
if (!encoded) throw new Error('Benchmark worker requires one encoded case request.');
const request = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as BenchmarkCaseRequest;
process.stdout.write(`${formatWorkerResult(executeCase(request))}\n`);

import { parseCliOptions, runBenchmarks } from './run';

await runBenchmarks(parseCliOptions(process.argv.slice(2)));

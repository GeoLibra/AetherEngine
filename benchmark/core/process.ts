import { spawn } from 'node:child_process';

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `Benchmark child failed with exit code ${code ?? 'null'}${signal ? ` and signal ${signal}` : ''}: ${stderr.trim()}`
          )
        );
        return;
      }
      resolve(Object.freeze({ stdout, stderr }));
    });
  });
}

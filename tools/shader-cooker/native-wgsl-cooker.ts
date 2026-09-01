/**
 * @file Node-only native WGSL cooker adapter invoking `aether-naga-shader-validator`.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { decodeCookedShaderRuntimeArtifact } from '../../src/shader/artifact';
import type { CookedShaderRuntimeArtifact } from '../../src/shader/types';

/**
 * Result from executing a command.
 */
export interface NativeCookerProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Pluggable process runner signature for testing.
 */
export type NativeCookerProcessRunner = (
  command: string,
  args: readonly string[],
  options?: { signal?: AbortSignal; cwd?: string }
) => Promise<NativeCookerProcessResult>;

/**
 * Default process runner executing native child process.
 */
export const defaultProcessRunner: NativeCookerProcessRunner = (
  command,
  args,
  options
): Promise<NativeCookerProcessResult> => {
  return new Promise((resolvePromise, rejectPromise) => {
    if (options?.signal?.aborted) {
      rejectPromise(new Error('Process execution was aborted.'));
      return;
    }

    const child = spawn(command, args as string[], {
      cwd: options?.cwd,
      signal: options?.signal,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      rejectPromise(err);
    });

    child.on('close', (status) => {
      resolvePromise({
        status: status ?? 1,
        stdout,
        stderr
      });
    });
  });
};

/**
 * Configuration options for NativeWgslCooker.
 */
export interface NativeWgslCookerOptions {
  readonly runner?: NativeCookerProcessRunner | undefined;
  readonly cargoPath?: string | undefined;
  readonly manifestPath?: string | undefined;
  readonly cwd?: string | undefined;
}

/**
 * Request parameters for cooking a WGSL source.
 */
export interface NativeCookRequest {
  readonly sourcePath: string;
  readonly sourceUri: string;
  readonly metadataPath?: string | undefined;
}

/**
 * Cook execution options.
 */
export interface NativeCookExecutionOptions {
  readonly signal?: AbortSignal | undefined;
}

/**
 * Error thrown when native WGSL cooking fails.
 */
export class NativeCookerError extends Error {
  public readonly code: string;
  public readonly sourceUri: string;
  public readonly rawStderr: string;

  public constructor(
    message: string,
    options: { code: string; sourceUri: string; rawStderr: string }
  ) {
    super(message);
    this.name = 'NativeCookerError';
    this.code = options.code;
    this.sourceUri = options.sourceUri;
    this.rawStderr = options.rawStderr;
  }
}

/**
 * Native WGSL cooker adapter.
 * Wraps Cargo/Naga cooker binary execution and translates untrusted output into validated runtime artifacts.
 */
export class NativeWgslCooker {
  private readonly runner: NativeCookerProcessRunner;
  private readonly cargoPath: string;
  private readonly manifestPath: string;
  private readonly cwd?: string | undefined;

  public constructor(options: NativeWgslCookerOptions = {}) {
    this.runner = options.runner ?? defaultProcessRunner;
    this.cargoPath = options.cargoPath ?? process.env.CARGO ?? 'cargo';
    this.manifestPath = options.manifestPath ?? 'tools/naga-shader-validator/Cargo.toml';
    this.cwd = options.cwd;
  }

  /**
   * Cooks a WGSL source file into a validated CookedShaderRuntimeArtifact.
   *
   * @param request Source path, canonical URI, and optional metadata path.
   * @param options Execution options (e.g. AbortSignal).
   * @returns Validated immutable CookedShaderRuntimeArtifact snapshot.
   */
  public async cook(
    request: NativeCookRequest,
    options: NativeCookExecutionOptions = {}
  ): Promise<CookedShaderRuntimeArtifact> {
    if (options.signal?.aborted) {
      throw new Error('Native WGSL cook was aborted before execution.');
    }

    const { sourcePath, sourceUri, metadataPath } = request;

    const args: string[] = [
      '+1.95.0',
      'run',
      '--quiet',
      '--manifest-path',
      this.manifestPath,
      '--',
      'cook',
      sourcePath,
      '--source-uri',
      sourceUri
    ];

    if (metadataPath) {
      args.push('--metadata', metadataPath);
    }

    let result: NativeCookerProcessResult;
    try {
      result = await this.runner(this.cargoPath, Object.freeze(args), {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(this.cwd !== undefined ? { cwd: this.cwd } : {})
      });
    } catch (error: unknown) {
      const errMessage = error instanceof Error ? error.message : String(error);
      if (options.signal?.aborted || errMessage.toLowerCase().includes('aborted')) {
        throw new Error('Native WGSL cook was aborted.');
      }
      throw new Error(
        `Failed to execute native WGSL cooker (${this.cargoPath} +1.95.0). Please install with \`rustup toolchain install 1.95.0\`. Underlying error: ${errMessage}`
      );
    }

    if (result.status !== 0) {
      // Parse structured stderr if possible
      let errorCode = 'native-cook-failed';
      let errorMessage = 'Native WGSL cooking failed.';
      const trimmedStderr = result.stderr.trim();

      if (trimmedStderr) {
        try {
          const parsedStderr = JSON.parse(trimmedStderr) as Record<string, unknown>;
          if (typeof parsedStderr.code === 'string') {
            errorCode = parsedStderr.code;
          }
          if (typeof parsedStderr.message === 'string') {
            errorMessage = `${errorCode}: ${parsedStderr.message}`;
          } else {
            errorMessage = `Native cooker reported error "${errorCode}".`;
          }
        } catch {
          // Stderr is plain text, sanitize local paths
          errorMessage = trimmedStderr.replace(
            new RegExp(escapeRegExp(sourcePath), 'gu'),
            sourceUri
          );
        }
      }

      throw new NativeCookerError(errorMessage, {
        code: errorCode,
        sourceUri,
        rawStderr: result.stderr
      });
    }

    let parsedStdout: unknown;
    try {
      parsedStdout = JSON.parse(result.stdout);
    } catch (parseError: unknown) {
      throw new Error(
        `Native WGSL cooker produced invalid JSON stdout: ${parseError instanceof Error ? parseError.message : String(parseError)}`
      );
    }

    return decodeCookedShaderRuntimeArtifact(parsedStdout);
  }
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

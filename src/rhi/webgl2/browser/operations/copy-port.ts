import type { WebGL2NativeContextPort } from '../../types';
import { constant } from '../capability-query';
import { glCall, glObject } from '../gl-call';
import type { BrowserWebGL2Object } from '../types';
import type { BrowserWebGL2BufferTarget } from './resource-port';

export function createBrowserWebGL2CopyPort(
  gl: BrowserWebGL2Object,
  bufferTargets: WeakMap<object, BrowserWebGL2BufferTarget> = new WeakMap()
): Pick<WebGL2NativeContextPort, 'writeBuffer' | 'copyBufferToBuffer' | 'createSubmissionFence'> {
  return {
    writeBuffer(buffer, offset, data): void {
      const target = bufferTargets.get(buffer) ?? 'ARRAY_BUFFER';
      const uploadVertexArray =
        target === 'ELEMENT_ARRAY_BUFFER' ? glObject(gl, 'createVertexArray') : undefined;
      if (uploadVertexArray !== undefined) glCall(gl, 'bindVertexArray', [uploadVertexArray]);
      glCall(gl, 'bindBuffer', [constant(gl, target), buffer]);
      glCall(gl, 'bufferSubData', [constant(gl, target), offset, data]);
      if (uploadVertexArray !== undefined) {
        glCall(gl, 'bindVertexArray', [null]);
        glCall(gl, 'deleteVertexArray', [uploadVertexArray]);
      }
    },
    copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size): void {
      glCall(gl, 'bindBuffer', [constant(gl, 'COPY_READ_BUFFER'), source]);
      glCall(gl, 'bindBuffer', [constant(gl, 'COPY_WRITE_BUFFER'), destination]);
      glCall(gl, 'copyBufferSubData', [
        constant(gl, 'COPY_READ_BUFFER'),
        constant(gl, 'COPY_WRITE_BUFFER'),
        sourceOffset,
        destinationOffset,
        size
      ]);
    },
    createSubmissionFence(): Promise<void> {
      const sync = glObjectWithArgs(gl, 'fenceSync', [
        constant(gl, 'SYNC_GPU_COMMANDS_COMPLETE'),
        0
      ]);
      // Flush belongs to the logical submission terminal, never to an individual pass.
      glCall(gl, 'flush');
      return waitForFence(gl, sync);
    }
  };
}

function waitForFence(gl: BrowserWebGL2Object, sync: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      const status = glCall(gl, 'clientWaitSync', [sync, 0, 0]);
      if (
        status === constant(gl, 'ALREADY_SIGNALED') ||
        status === constant(gl, 'CONDITION_SATISFIED')
      ) {
        glCall(gl, 'deleteSync', [sync]);
        resolve();
        return;
      }
      if (status === constant(gl, 'WAIT_FAILED')) {
        glCall(gl, 'deleteSync', [sync]);
        reject(new Error('WebGL2 submission fence wait failed.'));
        return;
      }
      setTimeout(poll, 0);
    };
    poll();
  });
}

function glObjectWithArgs(gl: BrowserWebGL2Object, name: string, args: readonly unknown[]): object {
  const value = glCall(gl, name, args);
  if (typeof value !== 'object' || value === null)
    throw new Error(`WebGL2 ${name}() returned null.`);
  return value;
}

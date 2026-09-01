import { isRecord } from '../../core';
import { assertResourceLive, assertResourceOwnedBy } from './resource';
import type { NullDeviceOwner } from './resource';
import type {
  GPUBlendComponent,
  GPUColorTargetState,
  GPUDepthStencilState,
  GPUFragmentState,
  GPUMultisampleState,
  GPUProgrammableStage,
  GPUVertexAttribute,
  GPUVertexBufferLayout,
  GPUVertexState,
  RHIComputePipelineDescriptor,
  RHIRenderPipelineDescriptor,
  RHIShaderModule
} from '../contracts';

type PipelineStageName = 'Vertex' | 'Fragment' | 'Compute';

export function validateRenderPipelineDescriptor(
  descriptor: RHIRenderPipelineDescriptor,
  owner: NullDeviceOwner
): void {
  if (descriptor.fragment !== undefined && descriptor.vertex === undefined) {
    throw new Error('Vertex stage must be provided if fragment stage is present.');
  }
  validatePipelineStage(descriptor.vertex, 'Vertex', owner);
  validatePipelineStage(descriptor.fragment, 'Fragment', owner);
  validateVertexState(descriptor.vertex);
  validateFragmentState(descriptor.fragment);
  validateDepthStencilState(descriptor.depthStencil);
  validateMultisampleState(descriptor.multisample);
}

export function validateComputePipelineDescriptor(
  descriptor: RHIComputePipelineDescriptor,
  owner: NullDeviceOwner
): void {
  validatePipelineStage(descriptor.compute, 'Compute', owner);
}

function validatePipelineStage(
  stage: GPUProgrammableStage | undefined,
  name: PipelineStageName,
  owner: NullDeviceOwner
): void {
  if (stage === undefined) {
    return;
  }
  if (!isRecord(stage)) {
    throw new Error(`${name} stage must be an object.`);
  }
  if (stage.module === undefined) {
    throw new Error(`${name} stage module is required.`);
  }
  assertResourceOwnedBy(stage.module as RHIShaderModule, owner);
  assertResourceLive(stage.module as RHIShaderModule);

  if (stage.entryPoint !== undefined && !isNonEmptyString(stage.entryPoint)) {
    throw new Error(`${name} stage entryPoint must be a non-empty string.`);
  }
  validateProgrammableConstants(stage.constants, `${name} stage`);
}

function validateProgrammableConstants(
  constants: GPUProgrammableStage['constants'],
  path: string
): void {
  if (constants === undefined) {
    return;
  }
  if (!isRecord(constants)) {
    throw new Error(`${path} constants must be a record.`);
  }
  for (const [name, value] of Object.entries(constants)) {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} constant "${name}" must be a finite number.`);
    }
  }
}

function validateVertexState(state: GPUVertexState | undefined): void {
  if (state?.buffers === undefined) {
    return;
  }
  if (!Array.isArray(state.buffers)) {
    throw new Error('Vertex buffers must be an array.');
  }
  state.buffers.forEach((buffer, bufferIndex) => {
    if (buffer === null) {
      return;
    }
    validateVertexBufferLayout(buffer, bufferIndex);
  });
}

function validateVertexBufferLayout(buffer: GPUVertexBufferLayout, bufferIndex: number): void {
  if (!isRecord(buffer)) {
    throw new Error(`Vertex buffer ${bufferIndex} must be an object or null.`);
  }
  validateNonNegativeInteger(buffer.arrayStride, `Vertex buffer ${bufferIndex} arrayStride`);
  if (!Array.isArray(buffer.attributes)) {
    throw new Error(`Vertex buffer ${bufferIndex} attributes must be an array.`);
  }
  buffer.attributes.forEach((attribute, attributeIndex) => {
    validateVertexAttribute(attribute, bufferIndex, attributeIndex);
  });
}

function validateVertexAttribute(
  attribute: GPUVertexAttribute,
  bufferIndex: number,
  attributeIndex: number
): void {
  if (!isRecord(attribute)) {
    throw new Error(`Vertex buffer ${bufferIndex} attribute ${attributeIndex} must be an object.`);
  }
  const path = `Vertex buffer ${bufferIndex} attribute ${attributeIndex}`;
  validateNonEmptyString(attribute.format, `${path} format`);
  validateNonNegativeInteger(attribute.offset, `${path} offset`);
  validateNonNegativeInteger(attribute.shaderLocation, `${path} shaderLocation`);
}

function validateFragmentState(state: GPUFragmentState | undefined): void {
  if (state === undefined) {
    return;
  }
  if (!Array.isArray(state.targets)) {
    throw new Error('Fragment targets must be an array.');
  }
  state.targets.forEach((target, targetIndex) => {
    if (target === null) {
      return;
    }
    validateColorTargetState(target, targetIndex);
  });
}

function validateColorTargetState(target: GPUColorTargetState, targetIndex: number): void {
  if (!isRecord(target)) {
    throw new Error(`Fragment target ${targetIndex} must be an object or null.`);
  }
  validateNonEmptyString(target.format, `Fragment target ${targetIndex} format`);
  if (target.writeMask !== undefined) {
    validateNonNegativeInteger(target.writeMask, `Fragment target ${targetIndex} writeMask`);
  }
  if (target.blend !== undefined) {
    if (!isRecord(target.blend)) {
      throw new Error(`Fragment target ${targetIndex} blend must be an object.`);
    }
    validateBlendComponent(target.blend.color, `Fragment target ${targetIndex} blend color`);
    validateBlendComponent(target.blend.alpha, `Fragment target ${targetIndex} blend alpha`);
  }
}

function validateBlendComponent(component: GPUBlendComponent, path: string): void {
  if (!isRecord(component)) {
    throw new Error(`${path} must be an object.`);
  }
  validateNonEmptyString(component.srcFactor, `${path} srcFactor`);
  validateNonEmptyString(component.dstFactor, `${path} dstFactor`);
  if (component.operation !== undefined) {
    validateNonEmptyString(component.operation, `${path} operation`);
  }
}

function validateDepthStencilState(state: GPUDepthStencilState | undefined): void {
  if (state === undefined) {
    return;
  }
  if (!isRecord(state)) {
    throw new Error('Depth-stencil state must be an object.');
  }
  validateNonEmptyString(state.format, 'Depth-stencil format');
}

function validateMultisampleState(state: GPUMultisampleState | undefined): void {
  if (state === undefined) {
    return;
  }
  if (!isRecord(state)) {
    throw new Error('Multisample state must be an object.');
  }
  if (state.count !== undefined) {
    validatePositiveInteger(state.count, 'Multisample count');
  }
  if (state.mask !== undefined) {
    validateNonNegativeInteger(state.mask, 'Multisample mask');
  }
}

function validateNonEmptyString(value: unknown, path: string): void {
  if (!isNonEmptyString(value)) {
    throw new Error(`${path} must be a non-empty string.`);
  }
}

function validateNonNegativeInteger(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer.`);
  }
}

function validatePositiveInteger(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer.`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

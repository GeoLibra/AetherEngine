import type { RHIShaderModule } from '../resource-types';
import type { RHIShaderModuleDescriptor } from '../descriptor-types';
import { WebGL2ResourceBase } from './resource';
import type { WebGL2DeviceOwner } from './resource-types';

export class WebGL2ShaderModule extends WebGL2ResourceBase implements RHIShaderModule {
  readonly kind = 'shader-module';
  readonly descriptor: Readonly<RHIShaderModuleDescriptor>;
  constructor(id: number, owner: WebGL2DeviceOwner, descriptor: RHIShaderModuleDescriptor) {
    super(id, owner, Object.freeze({}), descriptor.label, false);
    if (typeof descriptor.code !== 'string' || descriptor.code.length === 0) {
      throw new Error('Shader module descriptor requires non-empty code.');
    }
    this.descriptor = Object.freeze({ ...descriptor });
  }
}

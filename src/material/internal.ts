import { setMaterialParameterByIndex } from './parameter-block';
import type { MaterialFieldIndex, MaterialParameterBlock, MaterialValue } from './types';

/** Direct-test adapter for the internal compiled-layout index path. */
export function setMaterialParameterAtIndex(
  block: MaterialParameterBlock,
  index: MaterialFieldIndex,
  value: MaterialValue
): MaterialParameterBlock {
  return setMaterialParameterByIndex(block, index, value);
}

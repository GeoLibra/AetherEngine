import type { RHIResource, RHIResourceRef } from '../contracts';

/** Creates the backend-neutral identity captured in recorded command streams. */
export function toResourceRef(resource: RHIResource): RHIResourceRef {
  const ref: RHIResourceRef = {
    kind: resource.kind,
    id: resource.id
  };
  if (resource.label !== undefined) {
    ref.label = resource.label;
  }
  return ref;
}

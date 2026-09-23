import React, { memo, useCallback } from 'react';
import { type AtomBindingProperty, type FieldRenderContainerProps } from './types.js';

export default function fieldRenderDecorator<T>(
  OriginalComponent: React.ComponentType<AtomBindingProperty<T>>
): React.ComponentType<FieldRenderContainerProps<T>> {
  const Memod = memo(OriginalComponent);

  function FieldRenderContainer({
    declaration,
    context,
    value,
    onChange
  }: FieldRenderContainerProps<T>) {
    const { path } = declaration;
    const setValueMethod = useCallback(
      (val: T) => {
        onChange?.({ path: path ?? '', value: val });
      },
      [path, onChange]
    );

    return (
      <Memod declaration={declaration} context={context} value={value} setValue={setValueMethod} />
    );
  }
  return FieldRenderContainer;
}

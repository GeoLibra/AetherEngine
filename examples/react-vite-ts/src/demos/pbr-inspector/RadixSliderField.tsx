import * as Slider from '@radix-ui/react-slider';
import type { AtomBindingProperty, NumberDeclaration } from './power-panel/types';

export function RadixSliderField({ declaration, value, setValue }: AtomBindingProperty) {
  const field = declaration as NumberDeclaration;
  const currentValue = typeof value === 'number' ? value : 0;
  const title = field.title ?? field.path;
  const valueLabel = currentValue.toFixed(2);
  return (
    <label className="pbr-slider-field">
      <span className="pbr-slider-label">
        <span>{title}</span>
        <output aria-label={`${title} value`}>{valueLabel}</output>
      </span>
      <Slider.Root
        className="pbr-slider"
        value={[currentValue]}
        min={field.min ?? 0}
        max={field.max ?? 1}
        step={field.step ?? 0.01}
        aria-label={title}
        onValueChange={([nextValue]) => {
          if (nextValue !== undefined) setValue(nextValue);
        }}
      >
        <Slider.Track className="pbr-slider-track">
          <Slider.Range className="pbr-slider-range" />
        </Slider.Track>
        <Slider.Thumb className="pbr-slider-thumb" />
      </Slider.Root>
    </label>
  );
}

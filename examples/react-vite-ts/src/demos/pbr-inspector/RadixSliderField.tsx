import * as Slider from '@radix-ui/react-slider';
import type { PbrInspectorField } from './pbr-inspector-schema';

export function RadixSliderField({
  field,
  value,
  onValueChange
}: Readonly<{
  field: PbrInspectorField;
  value: number;
  onValueChange: (value: number) => void;
}>) {
  const valueLabel = value.toFixed(2);
  return (
    <label className="pbr-slider-field" key={field.id}>
      <span className="pbr-slider-label">
        <span>{field.label}</span>
        <output aria-label={`${field.label} value`}>{valueLabel}</output>
      </span>
      <Slider.Root
        className="pbr-slider"
        value={[value]}
        min={field.minimum}
        max={field.maximum}
        step={field.step}
        aria-label={field.label}
        onValueChange={([nextValue]) => {
          if (nextValue !== undefined) onValueChange(nextValue);
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

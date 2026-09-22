import type { ReactNode } from 'react';
import type { PbrInspectorField, PbrInspectorGroup, PbrParameterKey } from './pbr-inspector-schema';

export interface PowerPanelProps {
  readonly groups: readonly PbrInspectorGroup[];
  readonly values: Readonly<Record<PbrParameterKey, number>>;
  readonly renderField: (
    field: PbrInspectorField,
    value: number,
    onValueChange: (value: number) => void
  ) => ReactNode;
  readonly onValueChange: (key: PbrParameterKey, value: number) => void;
}

/**
 * Minimal headless panel renderer adapted from power-panel's declaration,
 * value, and field-renderer model. It owns neither material state nor UI kit.
 */
export function PowerPanel({ groups, values, renderField, onValueChange }: PowerPanelProps) {
  return (
    <div className="pbr-power-panel">
      {groups.map((group) => (
        <section className="pbr-panel-group" key={group.id} aria-labelledby={`group-${group.id}`}>
          <h3 id={`group-${group.id}`}>{group.label}</h3>
          <div className="pbr-panel-fields">
            {group.fields.map((field) => (
              <div key={field.id}>
                {renderField(field, values[field.key], (value) => onValueChange(field.key, value))}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

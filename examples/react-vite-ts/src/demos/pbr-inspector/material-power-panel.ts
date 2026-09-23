import type { TypeSchema } from '@aether/engine';
import { FieldType, type Layout, type LayoutRow } from './power-panel/types';

/** Derives PowerPanel declarations from fields explicitly exposed by an engine schema. */
export function createMaterialPanelLayout(schema: TypeSchema<unknown>): Layout {
  const rows = new Map<string, LayoutRow>();

  for (const field of schema.fields) {
    if (field.type.kind !== 'number' || field.editor?.widget !== 'slider') continue;
    const group = field.editor.group ?? 'Parameters';
    const row = rows.get(group) ?? [];
    row.push({
      type: FieldType.Slider,
      path: field.name,
      key: String(field.id),
      title: field.editor.label ?? field.name,
      min: field.editor.range?.[0],
      max: field.editor.range?.[1],
      step: field.editor.step,
      size: 6
    });
    rows.set(group, row);
  }
  return [...rows.values()];
}

/** Creates the panel's initial immutable value from the same engine schema defaults. */
export function createMaterialPanelValue(
  schema: TypeSchema<unknown>
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      schema.fields
        .filter((field) => field.editor !== undefined && field.defaultValue !== undefined)
        .map((field) => [field.name, field.defaultValue])
    )
  );
}

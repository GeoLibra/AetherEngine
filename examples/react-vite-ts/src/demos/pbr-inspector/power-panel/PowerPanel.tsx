import React, { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { PowerPanelCell } from './PowerPanelCell';
import fieldRenderDecorator from './fieldRenderDecorator';
import layoutTransformer from './layoutTransformer';
import type {
  FieldStructure,
  UpdatePayload,
  Layout,
  FieldRenderMap,
  FieldComponentMap
} from './types';

export type PowerPanelProps = {
  declaration: Layout;
  fieldMap: FieldComponentMap;
  value: unknown;
  onChange: (payload: UpdatePayload) => void;
  rowStyle?: CSSProperties;
  rowClassName?: string;
  cellStyle?: CSSProperties;
  cellClassName?: string;
};

const DEFAUL_ROW_STYLE = {
  display: 'grid',
  gridTemplateColumns: 'repeat(12, 1fr)',
  gap: 2
};

const PowerPanel: React.FC<PowerPanelProps> = ({
  declaration,
  fieldMap,
  value,
  onChange,
  rowStyle = {},
  rowClassName,
  cellStyle = {},
  cellClassName
}: PowerPanelProps) => {
  const layoutList = useMemo(() => layoutTransformer(declaration, value), [declaration, value]);
  const fieldRenderElementMap = useMemo(
    () =>
      Object.entries(fieldMap).reduce<FieldRenderMap>(
        (declarationElementMap, [type, Component]) => {
          declarationElementMap[type] = fieldRenderDecorator(Component);
          return declarationElementMap;
        },
        {}
      ),
    [fieldMap]
  );

  return (
    <div>
      {layoutList.map((row: FieldStructure[], rowIndex) => {
        return (
          <div
            key={rowIndex}
            style={{
              ...DEFAUL_ROW_STYLE,
              ...rowStyle
            }}
            className={'power-panel-cell' + (rowClassName ? ` ${rowClassName}` : '')}
          >
            {row.map((item, index) => (
              <PowerPanelCell
                key={index}
                declarationItem={item}
                fieldRenderElementMap={fieldRenderElementMap}
                value={value}
                onChange={onChange}
                cellStyle={cellStyle}
                {...(cellClassName === undefined ? {} : { cellClassName })}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
};

export default PowerPanel;

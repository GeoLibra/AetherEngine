import { get, isEqual } from 'lodash-es';
import React, { type CSSProperties, useRef } from 'react';
import { type FieldStructure, type RequestContext, type UpdatePayload } from './types.js';
import { type FieldRenderMap, type RequestContextPathMap } from './types.js';

interface PowerPanelCellProps {
  declarationItem: FieldStructure;
  fieldRenderElementMap: FieldRenderMap;
  value: unknown;
  onChange: (payload: UpdatePayload) => void;
  cellStyle?: CSSProperties;
  cellClassName?: string;
}

const DEFAULT_CELL_STYLE = {
  marginTop: 4
};

const getStyle = (size: number) => {
  return {
    gridColumnStart: `span ${size}`
  };
};

const useContextFromPathMap = (
  value: unknown,
  requestContextPathMap: RequestContextPathMap = {}
) => {
  const contextRef = useRef<RequestContext>({});

  const nextContext = Object.entries(requestContextPathMap).reduce<RequestContext>(
    (result, [key, requestPath]) => {
      result[key] = get(value, requestPath);
      return result;
    },
    {}
  );

  if (!isEqual(contextRef.current, nextContext)) {
    contextRef.current = nextContext;
  }

  return contextRef.current;
};

export const PowerPanelCell: React.FC<PowerPanelCellProps> = ({
  declarationItem,
  fieldRenderElementMap,
  value,
  onChange,
  cellStyle = {},
  cellClassName
}) => {
  const { type, path, size, requestContextPathMap } = declarationItem;

  const Component = fieldRenderElementMap[type];

  const context = useContextFromPathMap(value, requestContextPathMap);
  const resultValue = path ? get(value, path) : value;

  if (!Component) {
    return null;
  }

  return (
    <div
      style={{
        ...DEFAULT_CELL_STYLE,
        ...cellStyle,
        ...getStyle(size ?? 1)
      }}
      className={'power-panel-cell' + (cellClassName ? ` ${cellClassName}` : '')}
    >
      <Component
        declaration={declarationItem}
        context={context}
        value={resultValue}
        onChange={onChange}
      />
    </div>
  );
};

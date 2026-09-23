import {
  type LayoutRow,
  type FieldDeclaration,
  ReservedWord,
  type RequestContextPathMap
} from '../types.js';
import { buildRealPath, ListParams } from '../utils';
import visibilityExpressionCalc from './visibilityExpressionCalc';

export default function rowItemReorder(
  row: LayoutRow,
  data: any,
  listParams: ListParams = {
    isInListLoop: false
  }
): FieldDeclaration[] {
  if (!row || row.length === 0) {
    return [];
  }

  let invisibleSize = 0;
  let growFieldCount = 0;
  const { listItemIndex } = listParams;
  const visibleRows = row.filter((item: any) => {
    if (item.visible && !visibilityExpressionCalc(item.visible, data, listParams)) {
      invisibleSize += item.size;
      return false;
    }

    if (item.grow) {
      growFieldCount += 1;
    }

    return true;
  });

  return visibleRows.map((visibleRow: any) => {
    const { visible, ...otherDeclartions } = visibleRow;
    const result = {
      ...otherDeclartions
    };

    if (result[ReservedWord.Path] !== undefined) {
      result[ReservedWord.Path] = buildRealPath(result.path, listParams);
    }

    if (result[ReservedWord.RequestContextPathMap] !== undefined) {
      result[ReservedWord.RequestContextPathMap] = Object.entries(
        <RequestContextPathMap>result[ReservedWord.RequestContextPathMap]
      ).reduce<RequestContextPathMap>((result, [key, requestPath]) => {
        result[key] = buildRealPath(requestPath, listParams);
        return result;
      }, {});
    }

    if (visibleRow.grow && invisibleSize > 0) {
      const growSize = Math.ceil(invisibleSize / growFieldCount);
      invisibleSize -= growSize;
      growFieldCount -= 1;
      result.size = visibleRow.size + growSize;
    }

    if (listItemIndex !== undefined) {
      result.index = listItemIndex;
    }

    return result;
  });
}

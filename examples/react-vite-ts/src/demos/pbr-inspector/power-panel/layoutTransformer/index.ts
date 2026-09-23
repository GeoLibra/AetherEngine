import { get } from 'lodash-es';
import { type Expression, type Layout, type LayoutItem, type FieldDeclaration } from '../types';
import { isRow, isSection, isList, type ListParams, buildRealPath } from '../utils';
import rowItemReorder from './rowItemReorder';
import visibilityExpressionCalc from './visibilityExpressionCalc';

export default function layoutTransformer(declaration: Layout, value: any): FieldDeclaration[][] {
  const result: FieldDeclaration[][] = [];

  const loopFields = (
    declarationArray: Layout,
    listParams: ListParams = {
      isInListLoop: false
    }
  ) => {
    declarationArray.forEach((declarationItem: LayoutItem) => {
      if (isRow(declarationItem)) {
        result.push(rowItemReorder(declarationItem, value, listParams));
      } else if (isSection(declarationItem)) {
        const { visible, fields } = declarationItem;
        if (
          (visible &&
            visibilityExpressionCalc(visible as Expression | Expression[], value, listParams)) ||
          !visible
        ) {
          loopFields(fields, listParams);
        }
      } else if (isList(declarationItem)) {
        const { path, fields } = declarationItem;
        const realPath = buildRealPath(path, listParams);

        const listData: any[] = get(value, realPath);
        const listFields = listData.map((_) => fields);
        listFields.forEach((listField, index) => {
          loopFields(listField, {
            isInListLoop: true,
            listPath: realPath,
            listItemIndex: index
          });
        });
      }
    });
  };

  loopFields(declaration);

  return result;
}

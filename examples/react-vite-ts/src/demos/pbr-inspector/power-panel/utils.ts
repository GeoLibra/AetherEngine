import { LayoutItem, LayoutRow, LayoutType, Section, List } from './types';

export function isRow(rowOrSection: LayoutItem): rowOrSection is LayoutRow {
  return Array.isArray(rowOrSection);
}

export function isSection(rowOrSection: LayoutItem): rowOrSection is Section {
  return (<Section>rowOrSection).type === LayoutType.Section;
}

export function isList(list: LayoutItem): list is List {
  return (<List>list).type === LayoutType.List;
}

export const buildRealPath = (
  path: string,
  { isInListLoop, listPath, listItemIndex }: ListParams
) => {
  if (!isInListLoop) {
    return path;
  }

  if (path === '') {
    const prefix = `${listPath}`;
    return prefix;
  }

  if (path.includes('$')) {
    const prefix = `${listPath}[${listItemIndex}]`;
    return path.replace('$', prefix);
  }
  return path;
};

export type ListParams = {
  isInListLoop: boolean;
  listPath?: string;
  listItemIndex?: number;
};

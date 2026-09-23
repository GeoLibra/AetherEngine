export type FieldStructure = {
  type: string;
  path?: string;
  size?: number;
  requestContextPathMap?: RequestContextPathMap;
  [key: string]: unknown;
};

export type AtomBindingProperty<T = unknown> = {
  declaration: FieldStructure;
  context: RequestContext;
  value: T | undefined;
  setValue: (value: T) => void;
};

export const FieldType = Object.freeze({
  Number: 'Number',
  String: 'String',
  Panel: 'Panel',
  Enum: 'Enum',
  Color: 'Color',
  Image: 'Image',
  Tab: 'Tab',
  Slider: 'Slider',
  RadioButton: 'RadioButton',
  CheckButton: 'CheckButton'
} as const);
export type FieldType = (typeof FieldType)[keyof typeof FieldType];

export type CommonDeclaration = {
  path: string;
  key?: string;
  size?: number;
  title?: string;
};

export type NumberDeclaration = {
  type: typeof FieldType.Number | typeof FieldType.Slider;
  min?: number;
  max?: number;
  step?: number;
  icon?: string;
  prefix?: string;
  suffix?: string;
} & CommonDeclaration;

export type ItemDefinition = {
  value: unknown;
  title: string;
  icon?: string;
};

export type EnumDeclaration = {
  type: typeof FieldType.Enum;
  items: ItemDefinition[];
} & CommonDeclaration;

export type GeneralField = {
  type: string;
  size?: number;
  path?: string;
  grow?: boolean;
  items?: readonly unknown[];
  [property: string]: unknown;
};

export type FieldDeclaration = NumberDeclaration | GeneralField | EnumDeclaration;

export type LayoutCell = FieldDeclaration;

export type LayoutRow = LayoutCell[];

export type LayoutItem = List | Section | LayoutRow;

export type Layout = LayoutItem[];

export const Operators = Object.freeze({
  Equal: '=',
  NotEqual: '!=',
  In: 'in',
  NotIn: 'notIn'
} as const);
export type Operators = (typeof Operators)[keyof typeof Operators];

export type Expression = [string, Operators, unknown];

export const LayoutType = Object.freeze({
  List: 'List',
  Section: 'Section'
} as const);
export type LayoutType = (typeof LayoutType)[keyof typeof LayoutType];

export type List = {
  type: typeof LayoutType.List;
  path: string;
  name?: string;
  fields: Layout;
};

export type Section = {
  type: typeof LayoutType.Section;
  name?: string;
  fields: Layout;
  visible?: Expression | Expression[];
};

export type UpdatePayload = {
  path: string;
  value: unknown;
};

export type FieldRenderContainerProps<T = unknown> = {
  declaration: FieldStructure;
  context: RequestContext;
  value: T | undefined;
  onChange?: (payload: UpdatePayload) => void;
};

export type FieldRenderMap = {
  [key: string]: ComponentType<FieldRenderContainerProps>;
};

export type FieldComponentMap = {
  [key: string]: ComponentType<AtomBindingProperty>;
};

export const ReservedWord = Object.freeze({
  Path: 'path',
  RequestContextPathMap: 'requestContextPathMap'
} as const);

export type RequestContextPathMap = {
  [key: string]: string;
};

export type RequestContext = {
  [key: string]: unknown;
};
import type { ComponentType } from 'react';

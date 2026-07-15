declare const extensionType: unique symbol;

export interface RHIExtensionToken<T> {
  readonly id: symbol;
  readonly name: string;
  readonly [extensionType]?: T;
}

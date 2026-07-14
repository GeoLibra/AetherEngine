export interface NativeServiceToken<T> {
  readonly key: symbol;
  readonly name: string;
  readonly __serviceType?: T;
}

export interface NativeServiceModule<T> {
  readonly name: string;
  readonly version: number;
  readonly required: boolean;
  readonly token: NativeServiceToken<T>;
  readonly create: () => T;
}

export interface NativeServiceUnavailableDiagnostic {
  readonly kind: 'optional-module-unavailable';
  readonly module: string;
  readonly requiredVersion: number;
  readonly actualVersion: number | undefined;
}

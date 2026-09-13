import type { ComponentType } from 'react';

export interface DemoProps {
  readonly mountScene?: boolean;
}

export interface DemoDefinition {
  readonly id: string;
  readonly path: string;
  readonly aliases?: readonly string[];
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly component: ComponentType<DemoProps>;
}

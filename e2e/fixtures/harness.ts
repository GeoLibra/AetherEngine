import { expect, test as base, type Page } from '@playwright/test';
import type { E2EProject } from '../projects';
import type { E2EState } from '../harness/types';

const SCENARIO_BY_PROJECT = {
  'browser-host-smoke': 'browser-host',
  'webgl2-render': 'webgl2',
  'webgpu-render': 'webgpu'
} as const satisfies Record<E2EProject, string>;

export interface E2EHarnessFixture {
  readonly page: Page;
  state(): Promise<E2EState>;
  resize(width: number, height: number, dpr: number): Promise<void>;
  teardown(): Promise<void>;
  canvasCount(): Promise<number>;
}

interface HarnessFixtures {
  readonly harness: E2EHarnessFixture;
}

export const test = base.extend<HarnessFixtures>({
  harness: async ({ page }, use, testInfo) => {
    const scenario = SCENARIO_BY_PROJECT[testInfo.project.name as E2EProject];
    if (scenario === undefined) {
      throw new Error(
        `No E2E harness scenario is configured for project "${testInfo.project.name}".`
      );
    }

    await page.goto(`/?scenario=${scenario}`);

    let teardownPromise: Promise<void> | undefined;
    const teardown = (): Promise<void> => {
      teardownPromise ??= page.evaluate(() => window.__AETHER_E2E__.teardown());
      return teardownPromise;
    };

    try {
      await expect
        .poll(() => page.evaluate(() => window.__AETHER_E2E__.state()), {
          message: `wait for the ${scenario} harness to finish booting`
        })
        .not.toMatchObject({ status: 'booting' });

      await use({
        page,
        state: () => page.evaluate(() => window.__AETHER_E2E__.state()),
        resize: (width, height, dpr) =>
          page.evaluate(
            ([nextWidth, nextHeight, nextDpr]) =>
              window.__AETHER_E2E__.resize(nextWidth, nextHeight, nextDpr),
            [width, height, dpr] as const
          ),
        teardown,
        canvasCount: () => page.locator('canvas').count()
      });
    } finally {
      await teardown();
    }
  }
});

export { expect } from '@playwright/test';

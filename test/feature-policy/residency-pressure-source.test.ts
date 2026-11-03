import { expect, test } from 'vitest';
import { createResidencyPressureFeaturePolicySource } from '../../src/feature-policy/residency-pressure-source';

test('selects approved quality before notifying restaging and restores only after normal recovery', () => {
  const events: string[] = [];
  const source = createResidencyPressureFeaturePolicySource((downgrade) => {
    events.push(downgrade ? 'reduce' : 'restore');
    return true;
  });
  const unsubscribe = source.subscribe((event) => events.push(event.kind));
  source.update('critical');
  source.update('critical');
  source.update('constrained');
  source.update('normal');
  expect(events).toEqual(['reduce', 'profile-changed', 'restore', 'profile-changed']);
  expect(unsubscribe()).toBe(true);
  source.update('critical');
  expect(events.at(-1)).toBe('reduce');
});

export function decrementLeaseCount(current: number | undefined, resourceLabel: string): number {
  if (current === undefined) {
    throw new Error(`Cannot release WebGL2 resource "${resourceLabel}" without a matching retain.`);
  }
  if (!Number.isInteger(current) || current <= 0) {
    throw new Error(`WebGL2 resource "${resourceLabel}" has invalid lease count ${current}.`);
  }
  return current - 1;
}

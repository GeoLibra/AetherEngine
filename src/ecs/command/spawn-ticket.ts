/**
 * Virtual placeholder ticket representing an entity queued to be spawned in a CommandBuffer.
 *
 * Resolved to a concrete 64-bit Entity handle upon `CommandBuffer.apply()`.
 */
export class SpawnTicket {
  constructor(
    /**
     * Unique private symbol identifying the owning CommandBuffer instance.
     */
    public readonly owner: symbol,
    /**
     * Monotonically increasing index within the owning CommandBuffer batch.
     */
    public readonly index: number
  ) {}
}

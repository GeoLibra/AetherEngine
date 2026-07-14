export type RHIDeviceState = 'live' | 'lost' | 'destroyed';
export type RHIResourceState = 'live' | 'disposed' | 'device-lost';

export interface DeviceLostInfo {
  readonly reason: 'destroyed' | 'unknown' | 'out-of-memory' | 'context-lost';
  readonly message: string;
  readonly generation: number;
}

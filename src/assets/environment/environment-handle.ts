/**
 * @file Runtime token identity for Environment assets.
 */

import { defineAssetType } from '../asset-handle';
import type { EnvironmentAsset } from './types';

/** Stable asset type token for environment assets. */
export const EnvironmentAssetType = defineAssetType<EnvironmentAsset>('asset.environment');

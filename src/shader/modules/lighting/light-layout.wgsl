// ============================================================================
// AetherEngine Shared Shader Module - Light List Memory Layout
// Defines byte-offset words and flag constants for packed light and receiver buffers.
// ============================================================================

const LIGHT_HEADER_WORDS: u32 = 4u;
const LIGHT_RECORD_WORDS: u32 = 16u;
const RECEIVER_RECORD_WORDS: u32 = 12u;

const LIGHT_KIND_DIRECTIONAL: u32 = 0u;

const BOUNDS_KIND_SPHERE: u32 = 0u;
const BOUNDS_KIND_AABB: u32 = 1u;

const LIGHT_FLAG_VALID_HEADER: u32 = 0x80000000u;
const LIGHT_FLAG_DIRECTIONAL_OVERFLOW: u32 = 0x80000000u;
const LIGHT_FLAG_LOCAL_OVERFLOW: u32 = 0x40000000u;

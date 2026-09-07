# Built-in Shader Subsystem

> Status: `Production Baseline`
> Design Authority: [`engine/design/v2/04-rendering/02-shader-system.md`](../../../engine/design/v2/04-rendering/02-shader-system.md)

---

## 1. Overview & Architecture Philosophy

The built-in shader subsystem provides the engine's core materials, post-processing filters, and culling/lighting kernels. Built-in shaders are authored in standard WGSL accompanied by versioned typed sidecar metadata (`*.wgsl.meta.json`). The native cooker compiles, reflects, and validates them via Naga at build time, generating immutable TypeScript runtime artifacts (`*.generated.ts`).

### Core Design Principles

1. **Logical Family Clustering**: Shaders are clustered into cohesive functional family subdirectories rather than flat files, grouping authoring sources, metadata, and generated runtime artifacts together. Family directories contain zero boilerplate translator wrappers.
2. **Declarative Built-in Lowering**: Built-in shaders configure their WebGL2 translation declaratively in `index.ts`. Standard shaders simply supply their artifact; only shaders with platform-specific deviations (e.g. sampler fanout) provide targeted `webgl2` overrides.
3. **RHI-Owned Backend Lowering**: Generic WebGL2 lowering (`createCookedArtifactWebGL2Translator`) and router (`createWebGL2TranslationRouter`) live in `src/rhi/webgl2/shader/`, cleanly separating backend driver lowering from shader asset management.
4. **Backend-Specific Family Implementations**: Where platform capabilities diverge (e.g. WebGPU compute shaders vs. WebGL2 integer-MRT raster kernels for light lists), families provide backend-explicit subdirectories (`webgpu/` and `webgl2/`) rather than ad-hoc suffix chains.

---

## 2. Directory Responsibilities

| Directory / File                             | Responsibility                                                                                          | Key Exports                                                                      |
| :------------------------------------------- | :------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------- |
| [`standard-lit/`](./standard-lit/)           | Baseline metallic-roughness PBR forward shading material asset                                          | `STANDARD_LIT_SHADER_ARTIFACT`, `STANDARD_LIT_SHADER_MODULE`                     |
| [`post-color/`](./post-color/)               | Post-processing tonemapping and color grading filter asset                                              | `POST_COLOR_SHADER_ARTIFACT`, `POST_COLOR_SHADER_MODULE`                         |
| [`light-list/`](./light-list/)               | Clustered light-culling kernels: WebGPU compute storage-buffer and WebGL2 integer-MRT raster transforms | `LIGHT_LIST_SHADER_ARTIFACT`, `LIGHT_LIST_WEBGL2_SHADER_ARTIFACT`                |
| [`standard-lit-list/`](./standard-lit-list/) | Forward lighting evaluation against clustered light lists with sampler-to-texture fanout                | `STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT`, `mapStandardLitListPhysicalBindings` |
| [`index.ts`](./index.ts)                     | Public package facade re-exporting canonical artifacts, built-in lowering table, and lowering port      | All built-in symbols, `BUILT_IN_WEBGL2_TRANSLATOR` & lowering adapter            |

---

## 3. Data Flow & Compilation Lifecycle

```mermaid
flowchart TD
    subgraph Offline["Offline Cooker (scripts/cook-built-in-shaders.ts)"]
        WGSL["Authoring WGSL (*.wgsl)"] --> Naga["Native Naga Cooker"]
        META["Sidecar Metadata (*.meta.json)"] --> Naga
        Naga --> GEN["Cooked Artifact (*.generated.ts)"]
    end

    subgraph Runtime["Runtime Subsystem"]
        GEN --> ROUTER["BUILT_IN_WEBGL2_TRANSLATOR (Direct Artifact Registry)"]
        ROUTER --> ADAPT["createCookedArtifactWebGL2Translator"]
        ADAPT --> WEBGL2["WebGL2 Device / Pipeline Creation"]
    end
```

---

## 4. Fail-Fast Invariants & Error Boundaries

- **Router Fail-Fast**: Passing an unknown or unregistered shader module to `BUILT_IN_WEBGL2_TRANSLATOR` throws immediately with the entry-point name and stage; it never silently falls back to a default material.
- **Entry-Point Enforcement**: Subsystem translators validate that requested entry points exist in the cooked artifact and conform to any declared `supportedEntryPoints` whitelist.
- **Binding Limits & Kinds**: Only supported WebGL2 binding kinds (`uniform-buffer`, `texture`, `sampler`) are accepted by the adapter; unhandled binding kinds throw structured errors during translation rather than producing invalid GLSL.
- **Artifact Immutability**: All generated runtime artifacts and reflected arrays/objects are deeply frozen (`Object.freeze`) at initialization.

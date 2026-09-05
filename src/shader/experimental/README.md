# Experimental & Compatibility Shader Subsystems (`src/shader/experimental`)

> Status: `Experimental / Compatibility`
> Design Authority: [`engine/design/v2/04-rendering/02-shader-system.md`](../../../engine/design/v2/04-rendering/02-shader-system.md)

---

## 1. Overview & Architecture Philosophy

This directory clusters experimental, non-normative, and legacy compatibility shader authoring pipelines.

### Core Invariants

1. **Normative Production Boundary**: The approved production authoring contract is standard WGSL plus versioned typed sidecar metadata (`.wgsl` + `.wgsl.meta.json`), cooked by the native Naga-based cooker (`tools/naga-shader-validator`). Production browser/runtime bundles do NOT load or evaluate code from this directory.
2. **Explicit Opt-in**: The pipelines here correspond to:
   - `flux-experimental`: Legacy FluxSL lexer, parser, typed IR, backend emitters, and compiler.
   - `shader-graph`: Proposed ShaderGraph node DAG and lowering service.
3. **No Leaks to Runtime**: Production bundles must never include source or symbols from this experimental directory. Build gates (`scripts/check-runtime-shader-bundle.ts`) explicitly enforce this boundary.
4. **No Custom GLSL Reverse Parsing**: ShaderGraph explicitly rejects custom GLSL parsers or private markers (e.g. `[main]`/`[init]`). Future code-to-node authoring converges on standard WGSL functions + typed metadata -> Naga reflection -> `ShaderNodeDefinition`.

---

## 2. Directory Structure

| Directory                            | Responsibility                                                                      |
| :----------------------------------- | :---------------------------------------------------------------------------------- |
| [`flux/frontend/`](./flux/frontend/) | FluxSL lexer, recursive-descent parser, source resolver, and type checker           |
| [`flux/ir/`](./flux/ir/)             | FluxSL typed intermediate representation (IR) definitions and builders              |
| [`flux/backends/`](./flux/backends/) | FluxSL backend emitters (WGSL and GLSL ES 3.00 with binding fusion)                 |
| [`flux/compiler/`](./flux/compiler/) | FluxSL offline compiler (`ShaderCompiler`) and cook dispatch (`cookShaderArtifact`) |
| [`graph/`](./graph/)                 | Experimental ShaderGraph DAG compiler and IR lowering service                       |

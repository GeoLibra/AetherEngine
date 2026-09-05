# Aether Doctor

Aether Doctor proves that the current machine can execute Aether's browser rendering path. It
does not infer support from browser flags or static API presence. Each successful backend verdict
comes from the existing E2E scene performing device and surface creation, pipeline creation,
render-pass encoding, native queue submission, visible pixel readback, and deterministic teardown.

Run the human-readable report:

```sh
pnpm doctor
```

Use JSON for automation and bug reports:

```sh
pnpm doctor -- --json
```

Show the supported options without starting a browser:

```sh
pnpm doctor --help
```

The preferred backend is WebGPU. WebGL2 is probed only when WebGPU does not verify, and a successful
fallback is reported as `verified-with-fallback`. Exit code `0` means one of those two verified
outcomes; `1` means failed, unsupported, or unverified; `2` means the command-line arguments are
invalid.

## Verdict contract

| Verdict                  | Meaning                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `verified`               | The preferred WebGPU path rendered, submitted, produced non-uniform opaque pixels, and tore down. |
| `verified-with-fallback` | WebGPU did not verify and the declared WebGL2 fallback completed the same proof.                  |
| `failed`                 | A probe encountered an operational error.                                                         |
| `unverified`             | Work ran, but the render, pixel, or teardown evidence was insufficient.                           |
| `unsupported`            | No attempted backend supports the required operation.                                             |

The pixel oracle intentionally checks structural evidence rather than a platform-specific golden:
the captured RGBA8 canvas must be non-empty, contain opaque pixels, and contain more than one color.
Rendered golden tests remain the authority for exact visual correctness.

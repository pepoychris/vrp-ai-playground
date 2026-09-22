# Visual identity and animation language

This document describes the Phase 2 visual layer of RoboRoute Nexus: the tokens every
scene, fixture and panel reads, and the animation vocabulary the fixtures and the
runtime share. The raw values live in
[`frontend/src/scene/visual-tokens.json`](../src/scene/visual-tokens.json), so the
fixture generator (Python), the asset benchmark (Node) and the frontend all read one
file instead of three copies.

## How the tokens reach the interface

| Layer | File | Role |
|---|---|---|
| Raw values | `frontend/src/scene/visual-tokens.json` | Palette, status colours, typography, spacing, lighting, icon and motion values |
| Typed surface | `frontend/src/scene/design-tokens.ts` | Types, sRGB to linear conversion, light tokens and the CSS variable map |
| Stylesheet | `frontend/src/index.css` | Consumes `--rr-*` custom properties with literal fallbacks |
| Runtime bridge | `frontend/src/main.tsx` | Calls `applyCssTokens()` once, writing the tokens onto `:root` |
| 3D scene | `frontend/src/scene/scene-shell.ts` | Builds the lighting rig, the ground plane and the fog from the same tokens |

`applyCssTokens()` is a no-op without a DOM, so importing the token module is safe in
server rendering and in unit tests.

## Palette

| Token | Value | Use |
|---|---|---|
| `surface` | `#14161a` | Page background |
| `surfaceRaised` | `#1b1e23` | Panels |
| `surfaceQuiet` | `#171a1f` | Secondary panels |
| `border` | `#2a2f37` | Panel and control borders |
| `text` | `#e7e9ee` | Primary text |
| `textMuted` | `#9aa2ae` | Secondary text, captions |
| `accent` | `#f0b429` | Brand accent, robot shell, progress fill |
| `ground` | `#20262e` | Stage ground plane |
| `sky` | `#111317` | Scene background and stage panel background |
| `robotShell` | `#f0b429` | Robot vehicle material |
| `robotTrim` | `#2f3742` | Reserved for robot trim details |
| `robotBeacon` | `#7fd1c1` | Reserved for robot beacons and status lights |
| `clawMetal` | `#8e99a8` | Claw material |
| `barrierArm` | `#f0b429` | Barrier arm material |
| `depotStructure` | `#4a5361` | Depot structure material |
| `depotBeacon` | `#e2e8f0` | Reserved for the depot beacon |
| `buildingShell` | `#37404c` | Building fixture material |

Material colours are stored as sRGB hex and written into the GLB as linear RGB factors,
which is what glTF requires. `srgbHexToLinearRgb()` in `design-tokens.ts` and
`hex_to_linear_rgba()` in the generator implement the same transfer function, and the
asset benchmark fails if a fixture material drifts from its token.

## Status colours

| State | Token | Value | Where it appears |
|---|---|---|---|
| Inactive | `idle` | `#7f8896` | Scenario status, waiting asset library |
| In progress | `loading` | `#f0b429` | Asset loading, paused simulation |
| Healthy | `ready` | `#4bbd7a` | API online, running simulation, assets ready |
| Partial | `degraded` | `#e0a33a` | Some fixtures failed, the rest still work |
| Failed | `error` | `#d9604f` | API offline, asset library unavailable |
| Failed alias | `unavailable` | `#d9604f` | Same meaning where "off" reads better |

## Typography

| Token | Value |
|---|---|
| `familyStack` | `'Segoe UI', system-ui, -apple-system, sans-serif` |
| `monoStack` | `Consolas, ui-monospace, SFMono-Regular, monospace` |
| `sizes.heading` | `22px` |
| `sizes.body` | `15px` |
| `sizes.caption` | `13px` |
| `sizes.label` | `12px` |
| `weights` | `400` regular, `600` strong |
| `letterSpacing.label` | `0.08em` |
| `lineHeight` | `1.5` |

Panel titles are uppercase `12px` labels with `0.08em` tracking; body text never uses
negative letter spacing.

## Spacing

`unit: 4`, then `xs 4`, `sm 8`, `md 12`, `lg 16`, `xl 24`, `xxl 32`. Radii are
`panelRadius: 8` and `controlRadius: 6`. Spacing is applied as `--rr-space-<name>`
custom properties.

## Lighting

| Light | Colour | Intensity | Position |
|---|---|---|---|
| Ambient | `#8fa3bf` | `0.55` | omnidirectional |
| Key | `#ffd9a0` | `2.1` | `[6, 10, 6]` |
| Fill | `#9fc4ff` | `0.65` | `[-7, 6, -5]` |
| Rim | `#f0b429` | `0.85` | `[0, 4, -9]` |

Fog runs from `24` to `72` units in `#111317`, and the ground plane uses `#20262e`
with roughness `0.95` and metalness `0.0`. No post-processing pass is enabled: the MVP
guard says the performance budget comes first.

## Icon tokens

`ICON_TOKENS` reserves names and sizes (`sm 16`, `md 20`, stroke `1.75`) for a future
icon library. No icon package is installed today, and the Phase 2 interface uses text
and colour only, so the interface never depends on a font that is not shipped.

## Motion

| Token | Value |
|---|---|
| `duration.fast` | `140ms` |
| `duration.base` | `220ms` |
| `duration.slow` | `420ms` |
| `duration.camera` | `600ms` |
| `easing.standard` | `cubic-bezier(0.2, 0, 0, 1)` |
| `easing.emphasis` | `cubic-bezier(0.3, 0, 0.1, 1)` |
| `easing.exit` | `cubic-bezier(0.4, 0, 1, 1)` |

When the system requests reduced motion the scene shell renders a single frame and
stops the animation loop, and the status note says so.

## Animation vocabulary

The four states are stable names, not labels:

| State | Clip name | Loop | Duration | Fixture that authors it |
|---|---|---|---|---|
| `idle` | `idle` | yes | `2000ms` | Robot vehicle |
| `move` | `move` | yes | `1500ms` | Robot vehicle |
| `grab` | `grab` | no | `900ms` | Robotic claw |
| `deploy` | `deploy` | no | `1000ms` | Barrier |

`depotLandmark` and `buildingFixture` declare `placeholderStates: ["idle"]`: they ship
no authored clip, so the runtime builds a deterministic procedural clip and marks it
as not authored. A fixture that loses an authored clip also receives the placeholder,
which keeps a missing animation visible instead of silent.

The names, labels and descriptions live in
[`frontend/src/scene/animation-states.ts`](../src/scene/animation-states.ts); clip
construction and the mixer director live in
[`frontend/src/scene/animation-clips.ts`](../src/scene/animation-clips.ts).

## Rules for later phases

1. Add a token to `visual-tokens.json` before using a new colour; never hard-code a hex
   value in a component.
2. Reuse fixture geometry and vary materials; do not author six full robot variants.
3. Export no texture or animation that the scene does not play.
4. Keep the budgets in `render-budget.json` green before adding post-processing.

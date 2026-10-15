# Rush Gear

A browser racing game that is **100 % procedural**: every track, car, texture, sound, sky and
piece of scenery is generated in code at runtime. No external models, textures, audio files or
fonts are loaded.

Built on the latest [three.js](https://threejs.org) with `WebGPURenderer` and TSL (Three
Shading Language). Falls back to WebGL 2 automatically when WebGPU is unavailable.

## Play

```
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

Pushes to `main` deploy to GitHub Pages via `.github/workflows/deploy.yml`.

| Key | Action |
| --- | --- |
| W / ↑ | throttle |
| S / ↓ | brake (hold while stopped: reverse) |
| A / D, ← / → | steer |
| Space | handbrake |
| Shift / Ctrl (E / Q) | gear up / down (manual gearbox) |
| C | cycle camera (chase, far chase, hood, onboard) |
| R | replay |
| P | autopilot |
| Esc | pause |

Gamepads work too (left stick, triggers, bumpers for gears).

## What is inside

**Game** — six circuits with elevation, banking, tunnels and named corners (coastal day,
mountain dusk, desert sunset, forest rain, night city, superspeedway); Championship (qualifying +
three races), Time Trial with persistent ghosts, Quick Race; eight AI opponents with
personalities, a minimum-curvature racing line, braking points, overtaking and defending;
sector times, best-lap records, live event feed, replays with trackside cameras; a garage with
five parametric cars.

**Physics** — fixed 120 Hz rigid-body simulation: raycast struts against an analytic track
surface, combined-slip tyres (Pacejka-style curves, friction ellipse, load sensitivity) solved
implicitly per wheel, engine torque curve, automatic/manual gearbox, ABS and traction control,
aero drag/downforce, surface types (asphalt, kerb, grass, gravel, sand, wet), wall and
car-to-car collisions with visible damage.

**Rendering** — `WebGPURenderer` + `RenderPipeline`: physically based Rayleigh/Mie sky with sun,
moon, stars and clouds driving a day/night cycle; 4-cascade shadow maps; image-based lighting
re-captured from the live sky; pooled point and spot lights for lamps and headlights; GTAO,
screen-space reflections, volumetric height fog with sun in-scatter, god rays, bloom, depth of
field, velocity motion blur, TRAA/SMAA, auto-exposure, colour grading, film grain, vignette and
heat haze. Materials are TSL node materials: clearcoat metal-flake paint with panel gaps and
damage, transmissive glass, a wet-road shader with puddles and rain ripples.

**Effects** — GPU particle pools (tyre smoke, sparks, dust, grass, spray, debris, exhaust
flames) integrated analytically in the vertex shader, camera-relative rain, persistent fading
skid marks.

**Audio** — everything synthesised with the Web Audio API: multi-layer engines by rpm and load,
wind, tyre screech, kerb rumble, gravel, impacts, crowd, rain and a step-sequenced soundtrack
that follows the race.

**Quality** — Low / Medium / High / Ultra presets (Ultra targets an RTX 5090-class GPU at 4K)
plus an adaptive controller that drops effects when frame time exceeds the target.

## Development

```
node scripts/ai-lap.mjs <track> <car> [laps]    # headless physics + AI lap (no browser)
node scripts/smoke.mjs --track azure --preset high --garage   # headless Chromium WebGPU run with screenshots
```

Source layout: `src/core` (math, input, settings), `src/world` (tracks, biomes, scenery),
`src/vehicle` (car data, builder, materials, physics), `src/ai`, `src/game` (race, camera,
replay, ghosts, championship), `src/render` (sky, lighting, post, particles, materials),
`src/audio`, `src/ui`.

# Changelog

## 1.1.0

- Open-sourced under the MIT license (`LICENSE`).
- Added `package.json` for npm/CDN distribution.
- Added `NESound.d.ts` TypeScript definitions.
- Added `dist/NESound.min.js` minified build (built with Terser) for
  `<script src="https://cdn.jsdelivr.net/gh/gaphop123/Nesound/dist/NESound.min.js">`-style loading.
- Added `test/smoke-test.js` and a GitHub Actions CI workflow
  (`.github/workflows/ci.yml`) running the test on every push/PR.
- Added `CONTRIBUTING.md`.
- No changes to APU emulation behavior in this release.

## 1.0.0

- Initial extraction: standalone 2A03 APU core (2 pulse, triangle, noise,
  DMC) pulled out of the JS-FamiTracker single-file HTML project and
  repackaged as the `NESound` UMD library.
- `write()`/`read()` register interface, `clock()`/`getOutput()`/`generate()`
  sample generation, `createAudioNode()` Web Audio helper, per-channel mute,
  PAL/NTSC switch, oscilloscope buffers, note/frequency tracking.

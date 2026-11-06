# NESound.js

[![License: MIT](https://img.shields.io/badge/license-MIT-33ff00.svg)](LICENSE)
[![CI](https://github.com/gaphop123/Nesound/actions/workflows/ci.yml/badge.svg)](https://github.com/gaphop123/Nesound/actions/workflows/ci.yml)

A tiny, dependency-free JavaScript emulation of the **NES / Famicom 2A03
Audio Processing Unit** — 2 pulse channels, 1 triangle, 1 noise, 1 DMC
(delta modulation / sample) channel.

Open source under the [MIT license](LICENSE). Repo:
**https://github.com/gaphop123/Nesound**

This library is the core APU engine pulled out of the larger
**JS‑FamiTracker** single-file HTML player and repackaged as a standalone,
reusable module. It contains **only** the stock 2A03 sound hardware
emulation — no 6502 CPU, no tracker UI, no expansion audio chips
(VRC6/VRC7/FDS/N163/EPSM/etc). You drive it by writing bytes to the same
`$4000`–`$4017` register addresses real NES software/drivers use, and pull
mixed stereo audio samples out at whatever sample rate you like.

It's useful for:
- Building your own NES/Famicom sound driver, tracker, or chiptune tool in JS
- Adding authentic NES-style sound effects/music to a browser game
- NSF-ish players, 8-bit audio toys, educational APU demos

## Files

```
NESound.js              the library (UMD: works as a <script>, CommonJS, or AMD module)
NESound.d.ts            TypeScript type definitions
dist/NESound.min.js     minified production build
example.html            a runnable demo page (open directly in a browser)
test/smoke-test.js      zero-dependency smoke test (`npm test`)
.github/workflows/ci.yml  GitHub Actions: runs the test on every push/PR
package.json            npm metadata (name: "nesound")
LICENSE                 MIT
CONTRIBUTING.md         how to contribute
CHANGELOG.md            version history
README.md               this file
```

## Install / include

No build step, no dependencies required at runtime. Pick whichever fits your project:

**Download / self-host** — just include the script:

```html
<script src="NESound.js"></script>
<script>
  const apu = new NESound({ sampleRate: 44100 });
</script>
```

**Load straight from GitHub via jsDelivr's CDN** (no install, auto-updates
with the repo — pin a tag/commit instead of `main` for production use):

```html
<script src="https://cdn.jsdelivr.net/gh/gaphop123/Nesound@main/NESound.js"></script>
<!-- or the minified build: -->
<script src="https://cdn.jsdelivr.net/gh/gaphop123/Nesound@main/dist/NESound.min.js"></script>
<script>
  const apu = new NESound({ sampleRate: 44100 });
</script>
```

**npm** (once published to the registry — see "Publishing" below):

```bash
npm install nesound
```

Or with Node/CommonJS/bundlers:

```js
const NESound = require('./NESound.js');
// or: import NESound from './NESound.js';
```

## Quick start

```js
const audioCtx = new AudioContext();
const apu = new NESound({ sampleRate: audioCtx.sampleRate });

// Hook the APU up to real audio output.
const node = apu.createAudioNode(audioCtx, 2048 /* buffer size */);
node.connect(audioCtx.destination);

// Write to APU registers just like real NES code would.
apu.write(0x4015, 0x01);          // enable Pulse 1
apu.write(0x4000, 0b10001111);    // duty=2, constant volume=15
apu.write(0x4002, 0x00);          // period low byte
apu.write(0x4003, 0x02);          // period high bits + restart/length load
```

That's it — Pulse 1 is now singing a tone through your speakers.

See `example.html` for a complete, runnable page that plays a little
arpeggio.

## API Reference

### `new NESound(options)`

| option        | type       | default   | description |
|---------------|------------|-----------|-------------|
| `sampleRate`  | number     | `44100`   | Default output sample rate. |
| `pal`         | boolean    | `false`   | Use PAL clock/noise/DMC timing tables instead of NTSC. |
| `readMemory`  | function(addr) → byte | `null` | Callback the DMC channel uses to fetch sample bytes from `$C000`–`$FFFF`. Only needed if you use the DMC channel; omit it and DMC just plays silence. |

### Registers

`NESound` understands the real NES APU register map:

| Address | Channel | Purpose |
|---|---|---|
| `$4000`–`$4003` | Pulse 1 | duty/volume, sweep, period lo, period hi + length + restart |
| `$4004`–`$4007` | Pulse 2 | (same layout as Pulse 1) |
| `$4008`,`$400A`,`$400B` | Triangle | linear counter/control, period lo, period hi + length + restart |
| `$400C`,`$400E`,`$400F` | Noise | volume/envelope, period+mode, length |
| `$4010`–`$4013` | DMC | rate/flags, direct output level, sample address, sample length |
| `$4015` | Status | write: channel enable mask (bit0=P1, bit1=P2, bit2=Tri, bit3=Noise, bit4=DMC). read: active/length-counter status. |
| `$4017` | Frame counter | 4-step/5-step mode, frame IRQ inhibit |

```js
apu.write(addr, value);   // write an 8-bit value to a register
apu.read(addr);           // currently meaningful only for $4015
```

If you already have (or are porting) code that pokes `$4000`–`$4017`
directly from an NSF/6502 emulator, you can wire its write handler straight
to `apu.write`.

### Clocking & audio generation

```js
apu.clock();                               // advance the APU by exactly 1 CPU cycle
apu.getOutput(sampleRate);                 // => { L, R } in roughly [-1, 1]
apu.generate(count, outL, outR, sampleRate); // bulk-fill count stereo samples
apu.createAudioNode(audioContext, bufferSize); // => ScriptProcessorNode, ready to .connect()
```

Internally, `generate()`/`createAudioNode()` do exactly what real hardware
does: for every output sample, accumulate `cpuClock / sampleRate` CPU
cycles, call `clock()` that many times, then call `getOutput()` once. If
you're driving your own 6502 emulator/sequencer loop, you can call
`apu.clock()` and `apu.getOutput()` yourself at the right cadence instead
of using `generate()`.

### Other useful methods

```js
apu.reset();                      // clears all channel state
apu.setPAL(true | false);         // switch NTSC <-> PAL timing
apu.setMemoryReader(fn);          // (re)attach the DMC sample-fetch callback
apu.setChannelMuted('pulse1', true); // mute an individual channel
apu.setMasterMuted(true);         // mute everything
apu.getChannelInfo();             // => { notes, freqs, vols } for VU meters / piano rolls
```

`notes`/`freqs`/`vols` are keyed by `'pulse1'`, `'pulse2'`, `'triangle'`,
`'noise'`, `'dmc'`, plus `vols.master`. `apu.oscBuffers.<channel>` is a
rolling `Float32Array(512)` per-channel waveform buffer, handy for drawing
oscilloscopes.

### Quality toggle

```js
apu.smoothTriangle = true; // interpolated triangle wave instead of the raw stepped DAC
```

## Using an AudioWorklet instead of ScriptProcessorNode

`createAudioNode()` uses the old (but universally supported)
`ScriptProcessorNode` for simplicity. For lower latency in a production
app, move the loop from `generate()` into an `AudioWorkletProcessor`:

```js
// nesound-worklet.js
class NESoundProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.apu = new NESound({ sampleRate });
    this.port.onmessage = (e) => {
      const { addr, val } = e.data;
      this.apu.write(addr, val);
    };
  }
  process(inputs, outputs) {
    const [outL, outR] = outputs[0];
    this.apu.generate(outL.length, outL, outR, sampleRate);
    return true;
  }
}
registerProcessor('nesound-processor', NESoundProcessor);
```

(`NESound.js` would need to be loaded/importable inside the worklet scope,
e.g. via `import` if you convert it to an ES module, since worklets don't
have access to the main thread's globals.)

## DMC sample playback

The DMC channel plays back 1-bit delta-encoded PCM samples straight from
CPU-addressable memory ($C000–$FFFF). Supply a `readMemory` callback that
returns a byte for a given 16-bit address — typically backed by whatever
ROM/RAM array your emulator or sample-loader uses:

```js
const prgRom = new Uint8Array(/* your sample data, mapped at 0xC000+ */);
const apu = new NESound({
  readMemory: (addr) => prgRom[addr - 0xC000] || 0
});
```

If you don't need DMC samples, you can ignore this entirely — pulse,
triangle, and noise work with zero extra setup.

## What's NOT included

This is intentionally just the 2A03 APU core, matching what was asked for:

- No 6502 CPU / NSF loader (bring your own driver, or drive registers by hand)
- No expansion audio (VRC6, VRC7, FDS, MMC5, N163, EPSM/YMF288, etc.)
- No tracker/sequencer/UI

If you need those, look at the original JS-FamiTracker project this was
extracted from.

## Publishing this to github.com/gaphop123/Nesound

This package is ready to push as-is — it just needs to actually land in
the (currently empty) repo. From inside the `NESound/` folder:

```bash
git init
git add .
git commit -m "NESound 1.1.0 — standalone 2A03 APU library"
git branch -M main
git remote add origin https://github.com/gaphop123/Nesound.git
git push -u origin main
```

Once it's pushed, the jsDelivr CDN links above (`cdn.jsdelivr.net/gh/gaphop123/Nesound@main/...`)
will work immediately — jsDelivr serves straight from GitHub, no extra
setup needed. To publish to npm as well (so `npm install nesound` works),
run `npm publish` from the same folder once you're logged in with
`npm login`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and PRs welcome at
https://github.com/gaphop123/Nesound.

## License

MIT — see [LICENSE](LICENSE). Do whatever you like with it, attribution
appreciated but not required.

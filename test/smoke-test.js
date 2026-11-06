// Minimal smoke test — no test framework dependency on purpose, so
// `npm test` works with zero install on a fresh clone.
const assert = require('assert');
const NESound = require('../NESound.js');

function run() {
  // --- construction & defaults ---
  const apu = new NESound({ sampleRate: 44100 });
  assert.strictEqual(apu.sampleRate, 44100);
  assert.strictEqual(apu.cpuClock, NESound.CPU_CLOCK_NTSC);

  // --- PAL switch ---
  apu.setPAL(true);
  assert.strictEqual(apu.cpuClock, NESound.CPU_CLOCK_PAL);
  apu.setPAL(false);

  // --- register writes don't throw, $4015 read reflects enabled channels ---
  apu.write(0x4015, 0x01);
  apu.write(0x4000, 0b10001111); // pulse1: duty 2, constant volume 15
  apu.write(0x4002, 0x00);
  apu.write(0x4003, 0x02);       // restart + length load
  const status = apu.read(0x4015);
  assert.strictEqual(status & 0x01, 0x01, 'pulse1 length counter should be active right after key-on');

  // --- audio generation produces non-silent, finite, in-range samples ---
  const n = 4096;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  apu.generate(n, L, R);

  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    assert.ok(isFinite(L[i]) && isFinite(R[i]), 'samples must be finite');
    assert.ok(L[i] >= -1 && L[i] <= 1, 'L sample out of range');
    assert.ok(R[i] >= -1 && R[i] <= 1, 'R sample out of range');
    maxAbs = Math.max(maxAbs, Math.abs(L[i]), Math.abs(R[i]));
  }
  assert.ok(maxAbs > 0.01, 'expected audible output from an enabled pulse channel');

  // --- mute silences output ---
  apu.setMasterMuted(true);
  const sample = apu.getOutput();
  assert.strictEqual(sample.L, 0);
  assert.strictEqual(sample.R, 0);
  apu.setMasterMuted(false);

  // --- reset clears state ---
  apu.reset();
  assert.strictEqual(apu.p1.lengthCounter, 0);

  console.log('NESound smoke test: all assertions passed.');
}

run();

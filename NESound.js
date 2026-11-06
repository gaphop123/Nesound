/*!
 * NESound.js
 * --------------------------------------------------------------------------
 * A tiny, dependency-free JavaScript emulation of the NES / Famicom 2A03
 * Audio Processing Unit (2x pulse, 1x triangle, 1x noise, 1x DMC channel).
 *
 * This is the core APU engine extracted from the "JS-FamiTracker" project
 * and repackaged as a standalone, reusable library. It contains ONLY the
 * stock 2A03 sound hardware emulation -- no CPU, no expansion audio chips
 * (VRC6/VRC7/FDS/N163/EPSM/etc.), no tracker/UI code. You drive it by
 * writing to the same $4000-$4017 register addresses real NES software
 * would use, then pulling audio samples out at whatever sample rate you
 * like.
 *
 * Usage (quick start):
 *
 *   const apu = new NESound({ sampleRate: 44100 });
 *   const audioCtx = new AudioContext();
 *   const node = apu.createAudioNode(audioCtx);
 *   node.connect(audioCtx.destination);
 *
 *   // Somewhere in your emulator / driver / sequencer:
 *   apu.write(0x4000, 0b10111111); // pulse 1 duty/volume
 *   apu.write(0x4002, 0x00);       // pulse 1 period lo
 *   apu.write(0x4003, 0x02);       // pulse 1 period hi + length + restart
 *   apu.write(0x4015, 0x0F);       // enable pulse1/pulse2/triangle/noise
 *
 * See README.md for the full API reference and a complete example.
 *
 * License: MIT
 * --------------------------------------------------------------------------
 */
(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && typeof module.exports === 'object') {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else {
        root.NESound = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ------------------------------------------------------------------
    // Hardware constants (NTSC/PAL clocks, lookup tables). These values
    // come directly from nesdev.org documentation of the 2A03 APU.
    // ------------------------------------------------------------------
    var CPU_CLOCK_NTSC = 1789773;
    var CPU_CLOCK_PAL = 1662607;

    var lengthTable = [10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
                        12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30];
    var dutyTable = [[0, 1, 0, 0, 0, 0, 0, 0],
                      [0, 1, 1, 0, 0, 0, 0, 0],
                      [0, 1, 1, 1, 1, 0, 0, 0],
                      [1, 0, 0, 1, 1, 1, 1, 1]];
    var triTable = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
                     0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    var noiseTableNTSC = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
    var dmcRatesNTSC = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];
    var noiseTablePAL = [4, 8, 14, 30, 60, 88, 118, 148, 188, 236, 354, 472, 708, 944, 1890, 3778];
    var dmcRatesPAL = [398, 354, 316, 298, 276, 236, 210, 198, 176, 148, 132, 118, 98, 78, 66, 50];

    function getNoteString(freq) {
        if (freq < 16 || freq > 8000) return '---';
        var notes = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
        var midi = Math.round(12 * Math.log2(freq / 440)) + 69;
        var octave = Math.floor(midi / 12) - 1;
        return notes[midi % 12] + octave;
    }

    // ------------------------------------------------------------------
    // NESound
    // ------------------------------------------------------------------
    /**
     * @param {Object} [options]
     * @param {number} [options.sampleRate=44100]  Default output sample rate.
     * @param {boolean} [options.pal=false]         Use PAL clock/noise/DMC tables.
     * @param {function(number):number} [options.readMemory]
     *        Callback used by the DMC channel to fetch sample bytes from
     *        $C000-$FFFF (CPU address space). Receives a 16-bit address and
     *        must return an 8-bit value. If omitted, DMC playback is
     *        silent (returns 0 bytes), which is fine if you don't use DMC.
     */
    function NESound(options) {
        options = options || {};
        this.sampleRate = options.sampleRate || 44100;
        this.readMemory = typeof options.readMemory === 'function' ? options.readMemory : null;

        this.cpuClock = CPU_CLOCK_NTSC;
        this.noisePeriods = noiseTableNTSC.slice();
        this.dmcPeriods = dmcRatesNTSC.slice();

        this.muted = {};
        this.vols = { master: 0 };
        this.notes = {};
        this.freqs = {};
        this._lastNotes = {};
        this.masterMuted = false;

        // Visual/analysis aids: continuous per-channel oscilloscope buffers,
        // mirroring the originating project. Entirely optional to use.
        this.oscBuffers = {};
        this.oscPtr = 0;
        this.isStereo = true;

        // Quality-of-life toggles carried over from JS-FamiTracker:
        // "smooth" triangle interpolation instead of the raw stepped DAC.
        this.smoothTriangle = false;

        this.hardwareSweepMute = false;
        this._dcL = 0;
        this._dcR = 0;

        this._initChannels();

        if (options.pal) this.setPAL(true);

        this.setupChannels(['pulse1', 'pulse2', 'triangle', 'noise', 'dmc']);

        // Internal CPU-cycle accumulator used by generate()/createAudioNode().
        this._cpuAccumulator = 0;
    }

    NESound.CPU_CLOCK_NTSC = CPU_CLOCK_NTSC;
    NESound.CPU_CLOCK_PAL = CPU_CLOCK_PAL;

    NESound.prototype._initChannels = function () {
        this.p1 = this._createPulse();
        this.p2 = this._createPulse();
        this.tri = this._createTriangle();
        this.noise = this._createNoise();
        this.dmc = this._createDMC();
        this.frameCounterCycle = 0;
        this.frameStep = 0;
        this.frameMode5 = false;
        this.frameIrqInhibit = false;
        this.oscPtr = 0;
        this._dcL = this._dcR = 0;
    };

    NESound.prototype._createPulse = function () {
        return {
            duty: 0, volume: 0, constant: false, envLoop: false, timer: 0, timerPeriod: 0,
            sequence: 0, lengthCounter: 0, envStart: false, envVol: 0, envDivider: 0,
            enabled: false, sweepEnabled: false, sweepPeriod: 0, sweepNegate: false,
            sweepShift: 0, sweepDivider: 0, sweepReload: false, sweepMute: false
        };
    };
    NESound.prototype._createTriangle = function () {
        return {
            timer: 0, timerPeriod: 0, sequence: 0, lengthCounter: 0, linearCounter: 0,
            linearPeriod: 0, linearReload: false, control: false, enabled: false
        };
    };
    NESound.prototype._createNoise = function () {
        return {
            volume: 0, constant: false, envLoop: false, timer: 0, timerPeriod: 0, lfsr: 1,
            mode: false, lengthCounter: 0, envStart: false, envVol: 0, envDivider: 0, enabled: false
        };
    };
    NESound.prototype._createDMC = function () {
        return {
            enabled: false, irqEnable: false, loop: false, rateIndex: 0, timer: 0,
            timerPeriod: 428, outputLevel: 0, sampleAddress: 0xC000, sampleLength: 1,
            currentAddress: 0xC000, bytesRemaining: 0, shiftRegister: 0, bitsRemaining: 8,
            silenceFlag: true, readBuffer: null
        };
    };

    /** Switch between NTSC and PAL timing tables. */
    NESound.prototype.setPAL = function (isPal) {
        this.cpuClock = isPal ? CPU_CLOCK_PAL : CPU_CLOCK_NTSC;
        this.noisePeriods = (isPal ? noiseTablePAL : noiseTableNTSC).slice();
        this.dmcPeriods = (isPal ? dmcRatesPAL : dmcRatesNTSC).slice();
        this.dmc.timerPeriod = this.dmcPeriods[this.dmc.rateIndex & 15];
    };

    /** Provide/replace the callback the DMC channel uses to fetch sample bytes. */
    NESound.prototype.setMemoryReader = function (fn) {
        this.readMemory = typeof fn === 'function' ? fn : null;
    };

    /**
     * Register which logical channel names you want oscilloscope buffers
     * and note-tracking for. Defaults to all five stock channels already,
     * so this is only needed if you want a custom subset.
     */
    NESound.prototype.setupChannels = function (channelIds) {
        this.muted = {};
        this.vols = { master: this.vols.master || 0 };
        this.notes = {};
        this.freqs = {};
        this.oscBuffers = {};
        channelIds.forEach(function (id) {
            this.muted[id] = false;
            this.vols[id] = 0;
            this.freqs[id] = 0;
            this.notes[id] = '---';
            this.oscBuffers[id] = new Float32Array(512);
        }, this);
        this.oscPtr = 0;
    };

    /** Hard reset: clears all channel state (does not touch mute flags). */
    NESound.prototype.reset = function () {
        this._initChannels();
        for (var k in this.oscBuffers) {
            if (this.oscBuffers[k]) this.oscBuffers[k].fill(0);
        }
        this.vols.master = 0;
        this._cpuAccumulator = 0;
    };

    NESound.prototype.setChannelMuted = function (id, muted) { this.muted[id] = !!muted; };
    NESound.prototype.setMasterMuted = function (muted) { this.masterMuted = !!muted; };

    /**
     * Write a byte to an APU register ($4000-$4013, $4015, $4017), exactly
     * as a 6502 "STA $400x" instruction would from real NES software.
     */
    NESound.prototype.write = function (addr, val) {
        if (addr === 0x4000) { this.p1.duty = val >> 6; this.p1.envLoop = (val & 0x20) !== 0; this.p1.constant = (val & 0x10) !== 0; this.p1.volume = val & 0x0F; }
        else if (addr === 0x4001) { this.p1.sweepEnabled = (val & 0x80) !== 0; this.p1.sweepPeriod = (val >> 4) & 7; this.p1.sweepNegate = (val & 0x08) !== 0; this.p1.sweepShift = val & 7; this.p1.sweepReload = true; }
        else if (addr === 0x4002) { this.p1.timerPeriod = (this.p1.timerPeriod & 0x700) | val; }
        else if (addr === 0x4003) { this.p1.timerPeriod = (this.p1.timerPeriod & 0xFF) | ((val & 7) << 8); this.p1.sequence = 0; this.p1.envStart = true; if (this.p1.enabled) this.p1.lengthCounter = lengthTable[val >> 3]; }
        else if (addr === 0x4004) { this.p2.duty = val >> 6; this.p2.envLoop = (val & 0x20) !== 0; this.p2.constant = (val & 0x10) !== 0; this.p2.volume = val & 0x0F; }
        else if (addr === 0x4005) { this.p2.sweepEnabled = (val & 0x80) !== 0; this.p2.sweepPeriod = (val >> 4) & 7; this.p2.sweepNegate = (val & 0x08) !== 0; this.p2.sweepShift = val & 7; this.p2.sweepReload = true; }
        else if (addr === 0x4006) { this.p2.timerPeriod = (this.p2.timerPeriod & 0x700) | val; }
        else if (addr === 0x4007) { this.p2.timerPeriod = (this.p2.timerPeriod & 0xFF) | ((val & 7) << 8); this.p2.sequence = 0; this.p2.envStart = true; if (this.p2.enabled) this.p2.lengthCounter = lengthTable[val >> 3]; }
        else if (addr === 0x4008) { this.tri.control = (val & 0x80) !== 0; this.tri.linearPeriod = val & 0x7F; }
        else if (addr === 0x400A) { this.tri.timerPeriod = (this.tri.timerPeriod & 0x700) | val; }
        else if (addr === 0x400B) { this.tri.timerPeriod = (this.tri.timerPeriod & 0xFF) | ((val & 7) << 8); this.tri.linearReload = true; if (this.tri.enabled) this.tri.lengthCounter = lengthTable[val >> 3]; }
        else if (addr === 0x400C) { this.noise.envLoop = (val & 0x20) !== 0; this.noise.constant = (val & 0x10) !== 0; this.noise.volume = val & 0x0F; }
        else if (addr === 0x400E) { this.noise.mode = (val & 0x80) !== 0; this.noise.timerPeriod = this.noisePeriods[val & 0x0F]; }
        else if (addr === 0x400F) { this.noise.envStart = true; if (this.noise.enabled) this.noise.lengthCounter = lengthTable[val >> 3]; }
        else if (addr === 0x4010) { this.dmc.irqEnable = (val & 0x80) !== 0; this.dmc.loop = (val & 0x40) !== 0; this.dmc.rateIndex = val & 0x0F; this.dmc.timerPeriod = this.dmcPeriods[this.dmc.rateIndex]; }
        else if (addr === 0x4011) { this.dmc.outputLevel = val & 0x7F; }
        else if (addr === 0x4012) { this.dmc.sampleAddress = 0xC000 | (val << 6); }
        else if (addr === 0x4013) { this.dmc.sampleLength = (val << 4) + 1; }
        else if (addr === 0x4015) {
            this.p1.enabled = (val & 1) !== 0; if (!this.p1.enabled) this.p1.lengthCounter = 0;
            this.p2.enabled = (val & 2) !== 0; if (!this.p2.enabled) this.p2.lengthCounter = 0;
            this.tri.enabled = (val & 4) !== 0; if (!this.tri.enabled) this.tri.lengthCounter = 0;
            this.noise.enabled = (val & 8) !== 0; if (!this.noise.enabled) this.noise.lengthCounter = 0;
            this.dmc.enabled = (val & 16) !== 0;
            if (!this.dmc.enabled) {
                this.dmc.bytesRemaining = 0;
            } else if (this.dmc.bytesRemaining === 0) {
                this.dmc.currentAddress = this.dmc.sampleAddress;
                this.dmc.bytesRemaining = this.dmc.sampleLength;
                this._fillDMCBuffer();
            }
        }
        else if (addr === 0x4017) {
            this.frameMode5 = (val & 0x80) !== 0;
            this.frameIrqInhibit = (val & 0x40) !== 0;
            this.frameCounterCycle = 0; this.frameStep = 0;
            if (this.frameMode5) this._clockQuarterHalf();
        }
    };

    /**
     * Read an APU-visible register. Only $4015 (channel status) is
     * meaningful on real hardware; everything else returns 0.
     */
    NESound.prototype.read = function (addr) {
        if (addr === 0x4015) {
            var s = 0;
            if (this.p1.lengthCounter > 0) s |= 0x01;
            if (this.p2.lengthCounter > 0) s |= 0x02;
            if (this.tri.lengthCounter > 0) s |= 0x04;
            if (this.noise.lengthCounter > 0) s |= 0x08;
            if (this.dmc.bytesRemaining > 0 || this.dmc.sampleLength > 0) s |= 0x10;
            return s;
        }
        return 0;
    };

    NESound.prototype._fillDMCBuffer = function () {
        if (this.dmc.bytesRemaining > 0 && this.dmc.readBuffer === null) {
            this.dmc.readBuffer = this.readMemory ? (this.readMemory(this.dmc.currentAddress) & 0xFF) : 0;
            this.dmc.currentAddress++;
            if (this.dmc.currentAddress > 0xFFFF) this.dmc.currentAddress = 0x8000;
            this.dmc.bytesRemaining--;
            if (this.dmc.bytesRemaining === 0 && this.dmc.loop) {
                this.dmc.currentAddress = this.dmc.sampleAddress;
                this.dmc.bytesRemaining = this.dmc.sampleLength;
            }
        }
    };

    NESound.prototype._clockDMC = function () {
        var dmc = this.dmc;
        if (!dmc.silenceFlag) {
            if (dmc.shiftRegister & 1) { if (dmc.outputLevel <= 125) dmc.outputLevel += 2; }
            else { if (dmc.outputLevel >= 2) dmc.outputLevel -= 2; }
        }
        dmc.shiftRegister >>= 1; dmc.bitsRemaining--;
        if (dmc.bitsRemaining <= 0) {
            dmc.bitsRemaining = 8;
            if (dmc.readBuffer !== null) {
                dmc.silenceFlag = false; dmc.shiftRegister = dmc.readBuffer; dmc.readBuffer = null;
                this._fillDMCBuffer();
            } else {
                dmc.silenceFlag = true;
            }
        }
    };

    NESound.prototype._clockEnvelope = function (ch) {
        if (ch.envStart) {
            ch.envStart = false; ch.envVol = 15; ch.envDivider = ch.volume;
        } else if (ch.envDivider === 0) {
            ch.envDivider = ch.volume;
            if (ch.envVol === 0) { if (ch.envLoop) ch.envVol = 15; } else { ch.envVol--; }
        } else {
            ch.envDivider--;
        }
    };
    NESound.prototype._clockLength = function (ch) {
        var halt = (ch === this.tri) ? ch.control : ch.envLoop;
        if (!halt && ch.lengthCounter > 0) ch.lengthCounter--;
    };
    NESound.prototype._clockLinear = function (tri) {
        if (tri.linearReload) { tri.linearCounter = tri.linearPeriod; }
        else if (tri.linearCounter > 0) { tri.linearCounter--; }
        if (!tri.control) { tri.linearReload = false; }
    };
    NESound.prototype._clockSweep = function (ch, isPulse1) {
        var delta = ch.sweepShift ? (ch.timerPeriod >> ch.sweepShift) : 0;
        var targetPeriod = ch.timerPeriod;
        if (ch.sweepNegate) {
            targetPeriod -= delta;
            if (isPulse1) targetPeriod -= 1;
        } else {
            targetPeriod += delta;
        }
        ch.sweepMute = this.hardwareSweepMute && (ch.timerPeriod < 8 || targetPeriod > 0x7FF || targetPeriod < 0);

        if (ch.sweepDivider === 0 && ch.sweepEnabled && ch.sweepShift > 0 && !ch.sweepMute) {
            ch.timerPeriod = Math.max(0, Math.min(0x7FF, targetPeriod));
        }
        if (ch.sweepDivider === 0 || ch.sweepReload) {
            ch.sweepDivider = ch.sweepPeriod;
            ch.sweepReload = false;
        } else {
            ch.sweepDivider--;
        }
    };
    NESound.prototype._clockQuarterHalf = function () {
        this._clockEnvelope(this.p1); this._clockEnvelope(this.p2); this._clockEnvelope(this.noise); this._clockLinear(this.tri);
        this._clockLength(this.p1); this._clockLength(this.p2); this._clockLength(this.tri); this._clockLength(this.noise);
        this._clockSweep(this.p1, true); this._clockSweep(this.p2, false);
    };

    /**
     * Advance the APU by exactly one CPU cycle. Call this cpuClock/sampleRate
     * times (fractionally accumulated) per output sample -- see generate().
     */
    NESound.prototype.clock = function () {
        if ((this.frameCounterCycle & 1) === 0) {
            if (this.p1.timer === 0) { this.p1.timer = this.p1.timerPeriod; this.p1.sequence = (this.p1.sequence - 1) & 7; } else this.p1.timer--;
            if (this.p2.timer === 0) { this.p2.timer = this.p2.timerPeriod; this.p2.sequence = (this.p2.sequence - 1) & 7; } else this.p2.timer--;
        }
        if (this.tri.timer === 0) {
            this.tri.timer = this.tri.timerPeriod;
            if (this.tri.linearCounter > 0 && this.tri.lengthCounter > 0) this.tri.sequence = (this.tri.sequence + 1) & 31;
        } else this.tri.timer--;
        if (this.noise.timer === 0) {
            this.noise.timer = this.noise.timerPeriod;
            var feedback = (this.noise.lfsr & 1) ^ (this.noise.mode ? ((this.noise.lfsr >> 6) & 1) : ((this.noise.lfsr >> 1) & 1));
            this.noise.lfsr = (this.noise.lfsr >> 1) | (feedback << 14);
        } else this.noise.timer--;
        if (this.dmc.timer === 0) { this.dmc.timer = this.dmc.timerPeriod - 1; this._clockDMC(); } else { this.dmc.timer--; }

        this.frameCounterCycle++;
        var quarterCycles = this.cpuClock === CPU_CLOCK_PAL ? 8313 : 7457;
        if (this.frameCounterCycle >= quarterCycles) {
            this.frameCounterCycle -= quarterCycles; this.frameStep++;
            this._clockEnvelope(this.p1); this._clockEnvelope(this.p2); this._clockEnvelope(this.noise); this._clockLinear(this.tri);
            var halfStep = this.frameMode5 ? (this.frameStep === 2 || this.frameStep === 5) : (this.frameStep === 2 || this.frameStep === 4);
            if (halfStep) {
                this._clockLength(this.p1); this._clockLength(this.p2); this._clockLength(this.tri); this._clockLength(this.noise);
                this._clockSweep(this.p1, true); this._clockSweep(this.p2, false);
            }
            if (this.frameStep >= (this.frameMode5 ? 5 : 4)) this.frameStep = 0;
        }
    };

    /**
     * Mix and return the current analog-equivalent output as a single
     * stereo sample, using the standard non-linear 2A03 DAC mixing
     * formulas. Call once per output sample, after the appropriate
     * number of clock() calls for that sample period.
     * @param {number} [sampleRate] defaults to this.sampleRate
     * @returns {{L:number, R:number}} each in roughly [-1, 1]
     */
    NESound.prototype.getOutput = function (sampleRate) {
        sampleRate = sampleRate || this.sampleRate;
        var out_p1 = 0, out_p2 = 0, out_tri = 0, out_noise = 0, out_dmc = 0;
        var p1_freq = 0, p2_freq = 0, tri_freq = 0;

        if (!this.muted.pulse1 && this.p1.lengthCounter > 0 && !this.p1.sweepMute) {
            if (dutyTable[this.p1.duty][this.p1.sequence]) out_p1 = this.p1.constant ? this.p1.volume : this.p1.envVol;
            p1_freq = this.cpuClock / (16 * (this.p1.timerPeriod + 1));
        }
        if (!this.muted.pulse2 && this.p2.lengthCounter > 0 && !this.p2.sweepMute) {
            if (dutyTable[this.p2.duty][this.p2.sequence]) out_p2 = this.p2.constant ? this.p2.volume : this.p2.envVol;
            p2_freq = this.cpuClock / (16 * (this.p2.timerPeriod + 1));
        }
        if (!this.muted.triangle && this.tri.lengthCounter > 0 && this.tri.linearCounter > 0) {
            tri_freq = this.cpuClock / (32 * (this.tri.timerPeriod + 1));
            if (this.smoothTriangle && tri_freq > 0 && isFinite(tri_freq)) {
                if (this.tri._smoothPhase === undefined) this.tri._smoothPhase = 0;
                this.tri._smoothPhase += tri_freq / sampleRate;
                if (this.tri._smoothPhase >= 1) this.tri._smoothPhase -= Math.floor(this.tri._smoothPhase);
                var p = this.tri._smoothPhase;
                out_tri = (p < 0.5) ? (p * 2 * 15) : ((1 - p) * 2 * 15);
            } else {
                out_tri = triTable[this.tri.sequence];
            }
        }
        if (!this.muted.noise && this.noise.lengthCounter > 0 && (this.noise.lfsr & 1) === 0) {
            out_noise = this.noise.constant ? this.noise.volume : this.noise.envVol;
        }
        if (!this.muted.dmc) out_dmc = this.dmc.outputLevel;

        // --- note/frequency tracking (handy for VU meters / piano-roll UIs) ---
        var self = this;
        var noteHold = function (id, active, freq) {
            if (self.notes[id] === undefined) return;
            if (active && freq > 16 && freq < 8000) {
                var n = getNoteString(freq);
                self.notes[id] = n; self.freqs[id] = freq;
                self._lastNotes[id] = { n: n, f: freq, hold: 6 };
            } else if (self._lastNotes[id] && self._lastNotes[id].hold > 0) {
                self._lastNotes[id].hold--;
                self.notes[id] = self._lastNotes[id].n;
                self.freqs[id] = self._lastNotes[id].f;
            } else {
                self.notes[id] = '---'; self.freqs[id] = 0;
            }
        };
        noteHold('pulse1', out_p1 > 0 || (this.p1.lengthCounter > 0 && this.p1.timerPeriod > 0 && !this.p1.sweepMute), p1_freq);
        noteHold('pulse2', out_p2 > 0 || (this.p2.lengthCounter > 0 && this.p2.timerPeriod > 0 && !this.p2.sweepMute), p2_freq);
        noteHold('triangle', (this.tri.lengthCounter > 0 && this.tri.linearCounter > 0 && this.tri.timerPeriod > 0), tri_freq);
        if (this.notes.noise !== undefined) this.freqs.noise = (out_noise > 0) ? 8000 : 0;

        // --- oscilloscope buffers ---
        if (this.oscBuffers.pulse1) this.oscBuffers.pulse1[this.oscPtr] = (out_p1 / 15) - 0.5;
        if (this.oscBuffers.pulse2) this.oscBuffers.pulse2[this.oscPtr] = (out_p2 / 15) - 0.5;
        if (this.oscBuffers.triangle) this.oscBuffers.triangle[this.oscPtr] = (out_tri / 15) - 0.5;
        if (this.oscBuffers.noise) this.oscBuffers.noise[this.oscPtr] = (out_noise / 15) - 0.5;
        if (this.oscBuffers.dmc) this.oscBuffers.dmc[this.oscPtr] = (out_dmc / 127) - 0.5;
        this.oscPtr = (this.oscPtr + 1) % 512;

        this.vols.pulse1 = out_p1 / 15; this.vols.pulse2 = out_p2 / 15; this.vols.triangle = out_tri / 15;
        this.vols.noise = out_noise / 15; this.vols.dmc = out_dmc / 127;

        var act_p1 = this.muted.pulse1 ? 0 : out_p1;
        var act_p2 = this.muted.pulse2 ? 0 : out_p2;
        var act_tri = this.muted.triangle ? 0 : out_tri;
        var act_noise = this.muted.noise ? 0 : out_noise;
        var act_dmc = this.muted.dmc ? 0 : out_dmc;

        // Standard non-linear 2A03 DAC mixing (see nesdev.org "APU Mixer").
        var pulse_mix = 0, tnd_mix = 0;
        if (act_p1 !== 0 || act_p2 !== 0) pulse_mix = 95.88 / ((8128 / (act_p1 + act_p2)) + 100);
        if (act_tri !== 0 || act_noise !== 0 || act_dmc !== 0) {
            tnd_mix = 159.79 / (1 / ((act_tri / 8227) + (act_noise / 12241) + (act_dmc / 22638)) + 100);
        }
        var center_mix = pulse_mix + tnd_mix;

        var finalL = center_mix, finalR = center_mix;

        if (this.isStereo) {
            var pulse_L = 0, pulse_R = 0;
            if (act_p1 !== 0 || act_p2 !== 0) {
                pulse_L = 95.88 / ((8128 / (act_p1 * 1.5 + act_p2 * 0.5)) + 100);
                pulse_R = 95.88 / ((8128 / (act_p1 * 0.5 + act_p2 * 1.5)) + 100);
            }
            var tnd_L = 0, tnd_R = 0;
            if (act_tri !== 0 || act_noise !== 0 || act_dmc !== 0) {
                tnd_L = 159.79 / (1 / ((act_tri / 8227) + ((act_noise * 0.5) / 12241) + ((act_dmc * 1.5) / 22638)) + 100);
                tnd_R = 159.79 / (1 / ((act_tri / 8227) + ((act_noise * 1.5) / 12241) + ((act_dmc * 0.5) / 22638)) + 100);
            }
            finalL = pulse_L + tnd_L;
            finalR = pulse_R + tnd_R;
        }

        // Gentle DC-blocking + soft limiter.
        this._dcL = finalL - this._dcL + 0.995 * this._dcL;
        this._dcR = finalR - this._dcR + 0.995 * this._dcR;
        finalL = 0.95 * Math.tanh(this._dcL / 0.95);
        finalR = 0.95 * Math.tanh(this._dcR / 0.95);

        this.vols.master = Math.min(1.0, Math.max(Math.abs(finalL), Math.abs(finalR)));

        if (this.masterMuted) return { L: 0, R: 0 };
        return { L: finalL, R: finalR };
    };

    /**
     * Convenience bulk generator: fills Float32Arrays (or plain arrays)
     * with `count` stereo samples at the given sample rate, internally
     * driving clock()/getOutput() the correct number of times each.
     * Does NOT advance any CPU/driver/sequencer -- call your own register
     * writes before/within this as needed (e.g. via a callback), or drive
     * playback yourself and call generate() in smaller chunks.
     *
     * @param {number} count number of stereo sample frames to produce
     * @param {Float32Array|number[]} outL left channel output buffer
     * @param {Float32Array|number[]} outR right channel output buffer
     * @param {number} [sampleRate] defaults to this.sampleRate
     */
    NESound.prototype.generate = function (count, outL, outR, sampleRate) {
        sampleRate = sampleRate || this.sampleRate;
        var cyclesPerSample = this.cpuClock / sampleRate;
        for (var i = 0; i < count; i++) {
            this._cpuAccumulator += cyclesPerSample;
            while (this._cpuAccumulator >= 1) {
                this._cpuAccumulator -= 1;
                this.clock();
            }
            var sample = this.getOutput(sampleRate);
            outL[i] = sample.L;
            outR[i] = sample.R;
        }
    };

    /**
     * Create and return a ScriptProcessorNode wired to continuously pull
     * audio from this APU. You still need to call .connect(audioCtx.destination)
     * (or into your own graph) on the returned node.
     *
     * NOTE: ScriptProcessorNode is deprecated-but-universal; for a
     * production app consider porting generate() into an AudioWorkletProcessor
     * instead (see README "Using an AudioWorklet").
     *
     * @param {AudioContext} audioContext
     * @param {number} [bufferSize=4096]
     * @returns {ScriptProcessorNode}
     */
    NESound.prototype.createAudioNode = function (audioContext, bufferSize) {
        bufferSize = bufferSize || 4096;
        var node = audioContext.createScriptProcessor(bufferSize, 0, 2);
        var self = this;
        self.sampleRate = audioContext.sampleRate;
        node.onaudioprocess = function (e) {
            var outL = e.outputBuffer.getChannelData(0);
            var outR = e.outputBuffer.getChannelData(1);
            try {
                self.generate(outL.length, outL, outR, audioContext.sampleRate);
            } catch (err) {
                outL.fill(0); outR.fill(0);
            }
        };
        return node;
    };

    /** Returns {notes, freqs, vols} snapshots for building VU meters / piano rolls. */
    NESound.prototype.getChannelInfo = function () {
        return { notes: this.notes, freqs: this.freqs, vols: this.vols };
    };

    return NESound;
}));

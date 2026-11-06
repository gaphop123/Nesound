// Type definitions for NESound.js
// Project: https://github.com/gaphop123/Nesound

export interface NESoundOptions {
  /** Default output sample rate. Defaults to 44100. */
  sampleRate?: number;
  /** Use PAL clock/noise/DMC timing tables instead of NTSC. Defaults to false. */
  pal?: boolean;
  /** Callback the DMC channel uses to fetch sample bytes from $C000-$FFFF. */
  readMemory?: (address: number) => number;
}

export interface NESoundSample {
  L: number;
  R: number;
}

export interface NESoundChannelInfo {
  notes: Record<string, string>;
  freqs: Record<string, number>;
  vols: Record<string, number>;
}

export default class NESound {
  static readonly CPU_CLOCK_NTSC: number;
  static readonly CPU_CLOCK_PAL: number;

  sampleRate: number;
  cpuClock: number;
  masterMuted: boolean;
  isStereo: boolean;
  smoothTriangle: boolean;
  oscBuffers: Record<string, Float32Array>;

  constructor(options?: NESoundOptions);

  setPAL(isPal: boolean): void;
  setMemoryReader(fn: (address: number) => number): void;
  setupChannels(channelIds: string[]): void;
  reset(): void;
  setChannelMuted(id: string, muted: boolean): void;
  setMasterMuted(muted: boolean): void;

  write(addr: number, val: number): void;
  read(addr: number): number;

  clock(): void;
  getOutput(sampleRate?: number): NESoundSample;
  generate(
    count: number,
    outL: Float32Array | number[],
    outR: Float32Array | number[],
    sampleRate?: number
  ): void;

  createAudioNode(audioContext: AudioContext, bufferSize?: number): ScriptProcessorNode;
  getChannelInfo(): NESoundChannelInfo;
}

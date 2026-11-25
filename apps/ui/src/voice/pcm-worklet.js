// Voice input's capture (V259): runs on the audio thread and hands the microphone's samples to the page in blocks of
// about 85 ms (4096 samples at 48 kHz), the first channel only. Loaded with `audioWorklet.addModule` (`capture.ts`).
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(4096);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel === undefined) return true;
    let read = 0;
    while (read < channel.length) {
      const take = Math.min(channel.length - read, this.block.length - this.filled);
      this.block.set(channel.subarray(read, read + take), this.filled);
      this.filled += take;
      read += take;
      if (this.filled === this.block.length) {
        this.port.postMessage(this.block);
        this.block = new Float32Array(4096);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("omp-pcm-tap", PcmTap);

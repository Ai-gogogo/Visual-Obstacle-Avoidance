class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(Math.round(sampleRate * 0.032));
    this.offset = 0;
    this.energy = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const value of channel) {
      const clipped = Math.max(-1, Math.min(1, value));
      this.samples[this.offset++] = clipped * (clipped < 0 ? 32768 : 32767);
      this.energy += value * value;
      if (this.offset !== this.samples.length) continue;
      const samples = this.samples;
      this.port.postMessage({samples, rms:Math.sqrt(this.energy / samples.length)}, [samples.buffer]);
      this.samples = new Int16Array(this.offset);
      this.offset = 0;
      this.energy = 0;
    }
    return true;
  }
}

registerProcessor('voice-capture', VoiceCapture);

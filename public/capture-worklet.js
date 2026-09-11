class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.active = false; this.block = new Float32Array(2048); this.at = 0; this.frames = 0; this.meterAt = 0; this.square = 0; this.peak = 0; this.wave = [];
    this.port.onmessage = ({ data }) => {
      if (data.type === 'start') { this.at = 0; this.frames = 0; this.maxFrames = data.maxFrames; this.active = true; this.port.postMessage({ type: 'started' }); }
      if (data.type === 'stop') this.finish('manual');
    };
  }
  flush() { if (this.at) { const chunk = this.block.slice(0, this.at); this.port.postMessage({ type: 'chunk', chunk }, [chunk.buffer]); this.at = 0; } }
  finish(reason) { if (!this.active) return; this.active = false; this.flush(); this.port.postMessage({ type: 'stopped', reason, frames: this.frames }); }
  process(inputs) {
    const channels = inputs[0]; if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0; for (const channel of channels) sample += channel[i] / channels.length;
      this.square += sample * sample; this.peak = Math.max(this.peak, Math.abs(sample));
      if (this.meterAt % 32 === 0) this.wave.push(sample);
      if (++this.meterAt === 2048) { this.port.postMessage({ type: 'meter', rms: Math.sqrt(this.square / 2048), peak: this.peak, wave: this.wave }); this.meterAt = 0; this.square = 0; this.peak = 0; this.wave = []; }
      if (this.active) {
        this.block[this.at++] = sample; this.frames++;
        if (this.at === this.block.length) this.flush();
        if (this.frames >= this.maxFrames) this.finish('limit');
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);

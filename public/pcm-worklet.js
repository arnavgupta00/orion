class OrionPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.packetFrames = Math.max(128, Math.round(sampleRate * 0.08));
    this.packet = new Float32Array(this.packetFrames);
    this.packetOffset = 0;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message?.type === 'start') {
        this.enabled = true;
        return;
      }
      if (message?.type === 'drain') {
        this.enabled = false;
        this.flushPacket();
        this.port.postMessage({ type: 'drained', requestId: message.requestId });
        return;
      }
      if (message?.type === 'stop' || message?.enabled === false) {
        this.enabled = false;
        this.packetOffset = 0;
      }
    };
  }

  process(inputs) {
    if (!this.enabled) return true;
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;

    let inputOffset = 0;
    while (inputOffset < channel.length) {
      const available = this.packetFrames - this.packetOffset;
      const count = Math.min(available, channel.length - inputOffset);
      this.packet.set(channel.subarray(inputOffset, inputOffset + count), this.packetOffset);
      this.packetOffset += count;
      inputOffset += count;

      if (this.packetOffset === this.packetFrames) this.flushPacket();
    }
    return true;
  }

  flushPacket() {
    if (!this.packetOffset) return;
    const pcm = new Int16Array(this.packetOffset);
    for (let index = 0; index < this.packetOffset; index += 1) {
      const value = Math.max(-1, Math.min(1, this.packet[index] ?? 0));
      pcm[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    this.packetOffset = 0;
  }
}

registerProcessor('orion-pcm', OrionPcmProcessor);

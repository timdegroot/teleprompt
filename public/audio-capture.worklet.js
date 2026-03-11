class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
  }

  downsample(input, fromRate, toRate) {
    if (fromRate === toRate) {
      return input;
    }

    const ratio = fromRate / toRate;
    const length = Math.max(1, Math.round(input.length / ratio));
    const output = new Float32Array(length);
    let outputIndex = 0;
    let inputIndex = 0;

    while (outputIndex < length) {
      const nextInputIndex = Math.round((outputIndex + 1) * ratio);
      let sum = 0;
      let count = 0;

      for (let index = inputIndex; index < nextInputIndex && index < input.length; index += 1) {
        sum += input[index];
        count += 1;
      }

      output[outputIndex] = count ? sum / count : 0;
      outputIndex += 1;
      inputIndex = nextInputIndex;
    }

    return output;
  }

  process(inputs) {
    const input = inputs[0];

    if (!input || !input[0]) {
      return true;
    }

    const mono = input[0];
    const downsampled = this.downsample(mono, sampleRate, this.targetRate);
    const pcm = new Int16Array(downsampled.length);
    let rms = 0;

    for (let index = 0; index < downsampled.length; index += 1) {
      const clamped = Math.max(-1, Math.min(1, downsampled[index]));
      pcm[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      rms += clamped * clamped;
    }

    rms = Math.sqrt(rms / Math.max(1, downsampled.length));

    this.port.postMessage(
      {
        pcm: pcm.buffer,
        rms
      },
      [pcm.buffer]
    );

    return true;
  }
}

registerProcessor("pcm-capture", PCMCaptureProcessor);

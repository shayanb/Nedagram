/**
 * AudioWorklet processor for real-time audio processing
 *
 * Note: This file needs to be loaded as a separate module by AudioWorklet
 * In production, this would be bundled separately
 */

// Worklet processor code as a string (for dynamic loading)
export const workletCode = `
class NedagramProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.bufferSize = 4096;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0];

    // Add samples to buffer
    for (let i = 0; i < samples.length; i++) {
      this.buffer.push(samples[i]);
    }

    // Send buffer when full
    if (this.buffer.length >= this.bufferSize) {
      this.port.postMessage({
        type: 'samples',
        data: new Float32Array(this.buffer.slice(0, this.bufferSize)),
      });
      this.buffer = this.buffer.slice(this.bufferSize);
    }

    return true;
  }
}

registerProcessor('nedagram-processor', NedagramProcessor);
`;

/**
 * Load the AudioWorklet processor
 */
export async function loadWorklet(audioContext: AudioContext): Promise<void> {
  const blob = new Blob([workletCode], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);

  try {
    await audioContext.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Create a worklet node for audio processing
 */
export function createWorkletNode(
  audioContext: AudioContext,
  onSamples: (samples: Float32Array) => void
): AudioWorkletNode {
  const node = new AudioWorkletNode(audioContext, 'nedagram-processor');

  node.port.onmessage = (event) => {
    if (event.data.type === 'samples') {
      onSamples(event.data.data);
    }
  };

  return node;
}

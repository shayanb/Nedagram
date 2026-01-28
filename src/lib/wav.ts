/**
 * WAV file generation utilities
 */

/**
 * Create a WAV file from audio samples
 * @param samples Audio samples (Float32Array, values -1 to 1)
 * @param sampleRate Sample rate in Hz
 * @param numChannels Number of channels (1 = mono, 2 = stereo)
 * @param bitsPerSample Bits per sample (8, 16, or 32)
 * @returns WAV file as Uint8Array
 */
export function createWAV(
  samples: Float32Array,
  sampleRate: number,
  numChannels = 1,
  bitsPerSample = 16
): Uint8Array {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const fileSize = 44 + dataSize;

  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, fileSize - 8, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Chunk size
  view.setUint16(20, 1, true);  // Audio format (1 = PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write sample data
  const offset = 44;
  if (bitsPerSample === 16) {
    for (let i = 0; i < samples.length; i++) {
      // Clamp and convert to 16-bit signed integer
      const sample = Math.max(-1, Math.min(1, samples[i]));
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset + i * 2, int16, true);
    }
  } else if (bitsPerSample === 8) {
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      // 8-bit WAV is unsigned, centered at 128
      view.setUint8(offset + i, Math.floor((sample + 1) * 127.5));
    }
  } else if (bitsPerSample === 32) {
    for (let i = 0; i < samples.length; i++) {
      view.setFloat32(offset + i * 4, samples[i], true);
    }
  }

  return new Uint8Array(buffer);
}

/**
 * Create a download URL for a WAV file
 */
export function createWAVURL(samples: Float32Array, sampleRate: number): string {
  const wav = createWAV(samples, sampleRate);
  const blob = new Blob([wav as unknown as BlobPart], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

/**
 * Trigger download of a WAV file
 */
export function downloadWAV(samples: Float32Array, sampleRate: number, filename = 'nedagram.wav'): void {
  const url = createWAVURL(samples, sampleRate);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Helper function
function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Parse an audio file (WAV, MP3, M4A, etc.) and return Float32Array samples
 * Uses Web Audio API for broad format support
 */
export async function parseAudioFile(file: File): Promise<{ samples: Float32Array; sampleRate: number }> {
  const arrayBuffer = await file.arrayBuffer();

  // Create offline audio context for decoding
  const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();

  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    // Get mono samples (mix channels if stereo)
    let samples: Float32Array;
    if (audioBuffer.numberOfChannels === 1) {
      samples = audioBuffer.getChannelData(0);
    } else {
      // Mix down to mono
      const left = audioBuffer.getChannelData(0);
      const right = audioBuffer.getChannelData(1);
      samples = new Float32Array(left.length);
      for (let i = 0; i < left.length; i++) {
        samples[i] = (left[i] + right[i]) / 2;
      }
    }

    return {
      samples,
      sampleRate: audioBuffer.sampleRate,
    };
  } finally {
    await audioContext.close();
  }
}

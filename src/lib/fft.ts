/**
 * Radix-2 Cooley-Tukey FFT implementation
 * Optimized for power-of-2 sizes
 */

/**
 * Compute FFT of a real signal
 * @param signal Input signal (time domain)
 * @returns Complex array [real0, imag0, real1, imag1, ...]
 */
export function fft(signal: Float32Array): Float32Array {
  const n = signal.length;

  // Pad to next power of 2 if needed
  const size = nextPowerOf2(n);
  const real = new Float32Array(size);
  const imag = new Float32Array(size);

  // Copy input to real part
  real.set(signal);

  // Bit-reversal permutation
  bitReverse(real, imag, size);

  // Cooley-Tukey iterative FFT
  for (let len = 2; len <= size; len *= 2) {
    const halfLen = len / 2;
    const angle = -2 * Math.PI / len;

    for (let i = 0; i < size; i += len) {
      for (let j = 0; j < halfLen; j++) {
        const theta = angle * j;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);

        const evenIdx = i + j;
        const oddIdx = i + j + halfLen;

        const tReal = cosT * real[oddIdx] - sinT * imag[oddIdx];
        const tImag = sinT * real[oddIdx] + cosT * imag[oddIdx];

        real[oddIdx] = real[evenIdx] - tReal;
        imag[oddIdx] = imag[evenIdx] - tImag;
        real[evenIdx] = real[evenIdx] + tReal;
        imag[evenIdx] = imag[evenIdx] + tImag;
      }
    }
  }

  // Interleave real and imaginary parts
  const result = new Float32Array(size * 2);
  for (let i = 0; i < size; i++) {
    result[i * 2] = real[i];
    result[i * 2 + 1] = imag[i];
  }

  return result;
}

/**
 * Compute magnitude spectrum from FFT output
 * @param fftOutput Complex FFT output [real0, imag0, real1, imag1, ...]
 * @returns Magnitude array (only positive frequencies)
 */
export function magnitude(fftOutput: Float32Array): Float32Array {
  const n = fftOutput.length / 2;
  const mag = new Float32Array(n / 2); // Only positive frequencies

  for (let i = 0; i < n / 2; i++) {
    const real = fftOutput[i * 2];
    const imag = fftOutput[i * 2 + 1];
    mag[i] = Math.sqrt(real * real + imag * imag);
  }

  return mag;
}

/**
 * Find the frequency bin with maximum magnitude
 */
export function findPeakFrequency(
  magnitudes: Float32Array,
  sampleRate: number,
  minFreq: number,
  maxFreq: number
): { frequency: number; magnitude: number; bin: number } {
  const fftSize = magnitudes.length * 2;
  const binWidth = sampleRate / fftSize;

  const minBin = Math.floor(minFreq / binWidth);
  const maxBin = Math.ceil(maxFreq / binWidth);

  let peakBin = minBin;
  let peakMag = 0;

  for (let i = minBin; i < maxBin && i < magnitudes.length; i++) {
    if (magnitudes[i] > peakMag) {
      peakMag = magnitudes[i];
      peakBin = i;
    }
  }

  return {
    frequency: peakBin * binWidth,
    magnitude: peakMag,
    bin: peakBin,
  };
}

/**
 * Detect which tone (0-15) is present in the signal
 */
export function detectTone(
  magnitudes: Float32Array,
  sampleRate: number,
  toneFrequencies: number[],
  toneSpacing: number
): { tone: number; confidence: number } {
  const fftSize = magnitudes.length * 2;
  const binWidth = sampleRate / fftSize;

  let maxMagnitude = 0;
  let bestTone = -1;

  const halfSpacing = toneSpacing / 2;

  for (let t = 0; t < toneFrequencies.length; t++) {
    const freq = toneFrequencies[t];
    const minBin = Math.floor((freq - halfSpacing) / binWidth);
    const maxBin = Math.ceil((freq + halfSpacing) / binWidth);

    let toneMag = 0;
    for (let i = minBin; i <= maxBin && i < magnitudes.length; i++) {
      if (i >= 0) {
        toneMag = Math.max(toneMag, magnitudes[i]);
      }
    }

    if (toneMag > maxMagnitude) {
      maxMagnitude = toneMag;
      bestTone = t;
    }
  }

  // Calculate confidence based on ratio of best to average
  let avgMag = 0;
  for (let i = 0; i < magnitudes.length; i++) {
    avgMag += magnitudes[i];
  }
  avgMag /= magnitudes.length;

  const confidence = avgMag > 0 ? maxMagnitude / avgMag : 0;

  return {
    tone: bestTone,
    confidence: Math.min(confidence / 10, 1), // Normalize to 0-1
  };
}

// Helper functions

function nextPowerOf2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function bitReverse(real: Float32Array, imag: Float32Array, n: number): void {
  const bits = Math.log2(n);

  for (let i = 0; i < n; i++) {
    const j = reverseBits(i, bits);
    if (j > i) {
      // Swap real
      const tempR = real[i];
      real[i] = real[j];
      real[j] = tempR;
      // Swap imag
      const tempI = imag[i];
      imag[i] = imag[j];
      imag[j] = tempI;
    }
  }
}

function reverseBits(num: number, bits: number): number {
  let result = 0;
  for (let i = 0; i < bits; i++) {
    result = (result << 1) | (num & 1);
    num >>= 1;
  }
  return result;
}

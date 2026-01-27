/**
 * WebAudio context management
 */
import { AUDIO } from '../utils/constants';

let audioContext: AudioContext | null = null;

/**
 * Get or create the audio context
 * Must be called after user interaction (browser policy)
 */
export function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext({
      sampleRate: AUDIO.SAMPLE_RATE,
    });
  }
  return audioContext;
}

/**
 * Ensure audio context is ready for playback
 * Must be awaited on iOS before playing audio
 */
export async function ensureAudioContextReady(): Promise<AudioContext> {
  const ctx = getAudioContext();

  // Resume if suspended (required on iOS after user gesture)
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  return ctx;
}

/**
 * Get actual sample rate (may differ from requested)
 */
export function getSampleRate(): number {
  return getAudioContext().sampleRate;
}

/**
 * Close the audio context (cleanup)
 */
export function closeAudioContext(): void {
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
}

/**
 * Check if AudioWorklet is supported
 */
export function supportsAudioWorklet(): boolean {
  try {
    return 'AudioWorklet' in window && 'audioWorklet' in AudioContext.prototype;
  } catch {
    return false;
  }
}

/**
 * Create an audio buffer from Float32Array samples
 */
export function createAudioBuffer(samples: Float32Array, sampleRate: number): AudioBuffer {
  const ctx = getAudioContext();
  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  buffer.getChannelData(0).set(samples);
  return buffer;
}

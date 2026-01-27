/**
 * Audio playback utilities
 */
import { getAudioContext, createAudioBuffer, ensureAudioContextReady } from './context';

export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
}

export type PlaybackCallback = (state: PlaybackState) => void;

let currentSource: AudioBufferSourceNode | null = null;
let currentBuffer: AudioBuffer | null = null;
let startTime = 0;
let pauseOffset = 0;
let progressAnimationId: number | null = null;

/**
 * Play audio samples
 * Note: This is async to support iOS which requires awaiting context.resume()
 */
export async function playAudio(
  samples: Float32Array,
  sampleRate: number,
  onStateChange?: PlaybackCallback,
  onEnded?: () => void
): Promise<void> {
  stopAudio();

  // Ensure context is ready (important for iOS)
  const ctx = await ensureAudioContextReady();
  const buffer = createAudioBuffer(samples, sampleRate);
  currentBuffer = buffer;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);

  source.onended = () => {
    if (progressAnimationId) {
      cancelAnimationFrame(progressAnimationId);
      progressAnimationId = null;
    }
    currentSource = null;
    pauseOffset = 0;
    onStateChange?.({
      isPlaying: false,
      currentTime: buffer.duration,
      duration: buffer.duration,
    });
    onEnded?.();
  };

  startTime = ctx.currentTime - pauseOffset;
  source.start(0, pauseOffset);
  currentSource = source;

  // Start progress updates using requestAnimationFrame (more reliable on mobile)
  if (onStateChange) {
    onStateChange({
      isPlaying: true,
      currentTime: pauseOffset,
      duration: buffer.duration,
    });

    const updateProgress = () => {
      if (currentSource && currentBuffer) {
        const currentTime = ctx.currentTime - startTime;
        onStateChange({
          isPlaying: true,
          currentTime: Math.min(currentTime, currentBuffer.duration),
          duration: currentBuffer.duration,
        });
        progressAnimationId = requestAnimationFrame(updateProgress);
      }
    };
    progressAnimationId = requestAnimationFrame(updateProgress);
  }
}

/**
 * Stop audio playback
 */
export function stopAudio(): void {
  if (progressAnimationId) {
    cancelAnimationFrame(progressAnimationId);
    progressAnimationId = null;
  }
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      // Already stopped
    }
    currentSource = null;
  }
  pauseOffset = 0;
}

/**
 * Pause audio playback
 */
export function pauseAudio(): void {
  if (progressAnimationId) {
    cancelAnimationFrame(progressAnimationId);
    progressAnimationId = null;
  }
  if (currentSource) {
    const ctx = getAudioContext();
    pauseOffset = ctx.currentTime - startTime;
    try {
      currentSource.stop();
    } catch {
      // Already stopped
    }
    currentSource = null;
  }
}

/**
 * Check if audio is currently playing
 */
export function isPlaying(): boolean {
  return currentSource !== null;
}

/**
 * Get current playback time
 */
export function getCurrentTime(): number {
  if (!currentSource) return pauseOffset;
  const ctx = getAudioContext();
  return ctx.currentTime - startTime;
}

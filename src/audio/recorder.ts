/**
 * Microphone recording and audio processing
 */
import { getAudioContext, getSampleRate } from './context';

export interface RecorderCallbacks {
  onSamples: (samples: Float32Array) => void;
  onError: (error: Error) => void;
  onLevelChange?: (level: number) => void;
}

export type MicrophonePermissionResult = 'granted' | 'denied' | 'insecure-context';

/**
 * Check if we're in a secure context (HTTPS or localhost)
 */
export function isSecureContext(): boolean {
  // Check if the browser reports secure context
  if (typeof window !== 'undefined' && 'isSecureContext' in window) {
    return window.isSecureContext;
  }
  // Fallback: check protocol and hostname
  if (typeof location !== 'undefined') {
    const isLocalhost = location.hostname === 'localhost' ||
                        location.hostname === '127.0.0.1' ||
                        location.hostname === '[::1]' ||
                        location.hostname.endsWith('.localhost');
    return location.protocol === 'https:' || isLocalhost;
  }
  return true; // Assume secure if we can't check
}

let mediaStream: MediaStream | null = null;
let analyserNode: AnalyserNode | null = null;
let processorNode: ScriptProcessorNode | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let isRecording = false;

// Audio buffer for saving recordings
let recordedChunks: Float32Array[] = [];
let recordingSampleRate = 48000;

/**
 * Request microphone permission
 * Returns 'granted', 'denied', or 'insecure-context' for HTTP on network
 */
export async function requestMicrophonePermission(): Promise<MicrophonePermissionResult> {
  // Check for insecure context first
  if (!isSecureContext()) {
    return 'insecure-context';
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: getSampleRate(),
      },
    });

    // Stop the stream immediately, we just needed permission
    stream.getTracks().forEach(track => track.stop());
    return 'granted';
  } catch (err) {
    // NotAllowedError can mean either user denied or insecure context
    // NotFoundError means no microphone device
    // NotReadableError means device is in use or hardware error
    if (err instanceof Error) {
      // Some browsers throw NotAllowedError for insecure contexts
      if (err.name === 'NotAllowedError' && !isSecureContext()) {
        return 'insecure-context';
      }
    }
    return 'denied';
  }
}

/**
 * Start recording from microphone
 */
export async function startRecording(callbacks: RecorderCallbacks): Promise<void> {
  if (isRecording) return;

  // Clear previous recording
  recordedChunks = [];

  try {
    recordingSampleRate = getSampleRate();
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: recordingSampleRate,
      },
    });

    const ctx = getAudioContext();

    // Create source from microphone
    sourceNode = ctx.createMediaStreamSource(mediaStream);

    // Create input gain node to amplify weak signals (2x boost)
    const inputGainNode = ctx.createGain();
    inputGainNode.gain.value = 2.0;

    // Create analyser for level metering
    analyserNode = ctx.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.3;

    // Create script processor for raw samples
    // Buffer size of 4096 gives ~85ms of audio per callback at 48kHz
    const bufferSize = 4096;
    processorNode = ctx.createScriptProcessor(bufferSize, 1, 1);

    processorNode.onaudioprocess = (e) => {
      if (!isRecording) return;

      const inputBuffer = e.inputBuffer.getChannelData(0);
      const samples = new Float32Array(inputBuffer);

      // Save samples for later download
      recordedChunks.push(new Float32Array(samples));

      // Send samples to callback
      callbacks.onSamples(samples);

      // Calculate and report level
      if (callbacks.onLevelChange) {
        const level = calculateLevel(samples);
        callbacks.onLevelChange(level);
      }
    };

    // Connect nodes: source -> inputGain(2x) -> analyser -> processor -> destination (muted)
    sourceNode.connect(inputGainNode);
    inputGainNode.connect(analyserNode);
    analyserNode.connect(processorNode);

    // Connect to destination but with zero gain (needed to keep processor running)
    const gainNode = ctx.createGain();
    gainNode.gain.value = 0;
    processorNode.connect(gainNode);
    gainNode.connect(ctx.destination);

    isRecording = true;
  } catch (err) {
    callbacks.onError(err instanceof Error ? err : new Error('Failed to start recording'));
  }
}

/**
 * Stop recording
 */
export function stopRecording(): void {
  isRecording = false;

  if (processorNode) {
    processorNode.disconnect();
    processorNode = null;
  }

  if (analyserNode) {
    analyserNode.disconnect();
    analyserNode = null;
  }

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
}

/**
 * Check if currently recording
 */
export function getIsRecording(): boolean {
  return isRecording;
}

/**
 * Calculate audio level (0-100)
 */
function calculateLevel(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sum / samples.length);

  // Convert to 0-100 scale with some headroom
  const db = 20 * Math.log10(Math.max(rms, 1e-10));
  const normalized = Math.max(0, Math.min(100, (db + 60) * (100 / 60)));

  return normalized;
}

/**
 * Get frequency spectrum data (for visualization)
 */
export function getFrequencyData(): Uint8Array | null {
  if (!analyserNode) return null;

  const data = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteFrequencyData(data);
  return data;
}

/**
 * Get recorded audio as a single Float32Array
 */
export function getRecordedAudio(): { samples: Float32Array; sampleRate: number } | null {
  if (recordedChunks.length === 0) return null;

  // Calculate total length
  const totalLength = recordedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Float32Array(totalLength);

  // Concatenate all chunks
  let offset = 0;
  for (const chunk of recordedChunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }

  return { samples, sampleRate: recordingSampleRate };
}

/**
 * Clear recorded audio buffer
 */
export function clearRecordedAudio(): void {
  recordedChunks = [];
}

/**
 * Check if there's recorded audio available
 */
export function hasRecordedAudio(): boolean {
  return recordedChunks.length > 0;
}

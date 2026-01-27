/**
 * Block interleaver for burst error protection
 *
 * Interleaving spreads adjacent bytes across the transmission,
 * so burst errors (consecutive corrupted symbols) are spread out
 * and more likely to be correctable by RS decoding.
 */

/**
 * Interleave bytes using a block interleaver
 * @param data Input bytes
 * @param rows Number of rows in the interleaver matrix
 * @returns Interleaved bytes
 */
export function interleave(data: Uint8Array, rows: number): Uint8Array {
  const cols = Math.ceil(data.length / rows);
  const result = new Uint8Array(rows * cols);

  // Fill matrix row by row, read column by column
  for (let i = 0; i < data.length; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const newIndex = col * rows + row;
    result[newIndex] = data[i];
  }

  return result;
}

/**
 * De-interleave bytes (reverse of interleave)
 * @param data Interleaved bytes
 * @param rows Number of rows used in interleaving
 * @param originalLength Original data length (before padding)
 * @returns De-interleaved bytes
 */
export function deinterleave(data: Uint8Array, rows: number, originalLength: number): Uint8Array {
  const cols = Math.ceil(data.length / rows);
  const result = new Uint8Array(originalLength);

  // Read column by column, fill row by row
  for (let i = 0; i < originalLength; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const srcIndex = col * rows + row;
    result[i] = data[srcIndex];
  }

  return result;
}

/**
 * Calculate optimal interleaver depth based on frame size
 * We want enough rows to spread out burst errors across multiple RS blocks
 */
export function calculateInterleaverDepth(frameSize: number): number {
  // Use 8 rows as a good balance between burst protection and latency
  return 8;
}

/**
 * Interleave a complete transmission (all frames concatenated)
 */
export function interleaveTransmission(frames: Uint8Array[]): {
  interleaved: Uint8Array;
  depth: number;
  originalLengths: number[];
} {
  // Concatenate all frames
  const totalLength = frames.reduce((sum, f) => sum + f.length, 0);
  const combined = new Uint8Array(totalLength);

  let offset = 0;
  const originalLengths: number[] = [];
  for (const frame of frames) {
    combined.set(frame, offset);
    originalLengths.push(frame.length);
    offset += frame.length;
  }

  const depth = calculateInterleaverDepth(totalLength);
  const interleaved = interleave(combined, depth);

  return { interleaved, depth, originalLengths };
}

/**
 * De-interleave and split back into frames
 */
export function deinterleaveTransmission(
  interleaved: Uint8Array,
  depth: number,
  originalLengths: number[]
): Uint8Array[] {
  const totalLength = originalLengths.reduce((sum, l) => sum + l, 0);
  const deinterleaved = deinterleave(interleaved, depth, totalLength);

  // Split back into frames
  const frames: Uint8Array[] = [];
  let offset = 0;
  for (const length of originalLengths) {
    frames.push(deinterleaved.subarray(offset, offset + length));
    offset += length;
  }

  return frames;
}

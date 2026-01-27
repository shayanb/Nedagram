/**
 * Block interleaver for burst error protection
 *
 * Interleaving spreads adjacent bytes across the transmission,
 * so burst errors (consecutive corrupted symbols) are spread out
 * and more likely to be correctable by RS decoding.
 */

/**
 * Interleave bytes using a block interleaver (size-preserving)
 *
 * Conceptually fills a matrix row-by-row and reads column-by-column.
 * Handles incomplete matrices correctly to preserve original data size.
 *
 * @param data Input bytes
 * @param rows Desired interleaver depth (number of rows)
 * @returns Interleaved bytes (same size as input)
 */
export function interleave(data: Uint8Array, rows: number): Uint8Array {
  const len = data.length;
  if (len === 0 || rows <= 1) return new Uint8Array(data);

  const cols = Math.ceil(len / rows);
  const result = new Uint8Array(len);

  // Read column by column from the conceptual matrix
  // Element at original position i is at row=floor(i/cols), col=i%cols
  // Column c contains elements at positions: c, c+cols, c+2*cols, ...
  // Number of elements in column c = ceil((len - c) / cols)
  let writeIdx = 0;
  for (let col = 0; col < cols; col++) {
    const numInCol = Math.ceil((len - col) / cols);
    for (let row = 0; row < numInCol; row++) {
      const readIdx = row * cols + col;
      result[writeIdx++] = data[readIdx];
    }
  }

  return result;
}

/**
 * De-interleave bytes (reverse of interleave, size-preserving)
 * @param data Interleaved bytes
 * @param rows Number of rows used in interleaving
 * @param originalLength Original data length (should equal data.length)
 * @returns De-interleaved bytes
 */
export function deinterleave(data: Uint8Array, rows: number, originalLength: number): Uint8Array {
  const len = originalLength;
  if (len === 0 || rows <= 1) return new Uint8Array(data.subarray(0, len));

  const cols = Math.ceil(len / rows);
  const result = new Uint8Array(len);

  // Reverse: read in the same column-by-column order, write to original positions
  let readIdx = 0;
  for (let col = 0; col < cols; col++) {
    const numInCol = Math.ceil((len - col) / cols);
    for (let row = 0; row < numInCol; row++) {
      const writeIdx = row * cols + col;
      result[writeIdx] = data[readIdx++];
    }
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

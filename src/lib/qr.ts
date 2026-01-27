/**
 * QR code generation wrapper
 */
import qrcode from 'qrcode-generator';

/**
 * Generate QR code and render to canvas
 * @param data Data to encode
 * @param canvas Canvas element to render to
 * @param size Size of the QR code (default: auto-fit to canvas)
 */
export function generateQR(data: string, canvas: HTMLCanvasElement, size?: number): void {
  // Determine error correction level based on data length
  // L = 7% recovery, M = 15%, Q = 25%, H = 30%
  const typeNumber = 0; // Auto-detect
  const errorCorrectionLevel = data.length < 100 ? 'M' : 'L';

  const qr = qrcode(typeNumber, errorCorrectionLevel);
  qr.addData(data);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const cellSize = size ? Math.floor(size / moduleCount) : Math.floor(Math.min(canvas.width, canvas.height) / moduleCount);

  canvas.width = moduleCount * cellSize;
  canvas.height = moduleCount * cellSize;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // White background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw modules
  ctx.fillStyle = '#000000';
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
      }
    }
  }
}

/**
 * Generate QR code as data URL
 */
export function generateQRDataURL(data: string, size = 200): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  generateQR(data, canvas, size);
  return canvas.toDataURL('image/png');
}

/**
 * Check if data can fit in a QR code
 * Returns the approximate capacity utilization (0-1)
 */
export function checkQRCapacity(data: string): { canFit: boolean; utilization: number } {
  // QR code capacity depends on version and error correction
  // Version 40 with L correction can hold ~4296 alphanumeric chars
  // For binary data (8-bit), max is ~2953 bytes

  const maxBytes = 2953;
  const dataBytes = new TextEncoder().encode(data).length;

  return {
    canFit: dataBytes <= maxBytes,
    utilization: dataBytes / maxBytes,
  };
}

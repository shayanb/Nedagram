import { useEffect, useRef } from 'preact/hooks';
import { generateQR } from '../lib/qr';
import './QRDisplay.css';

interface QRDisplayProps {
  data: string;
  title?: string;
}

export function QRDisplay({ data, title }: QRDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !data) return;

    try {
      generateQR(data, canvasRef.current);
    } catch (err) {
      console.error('Failed to generate QR code:', err);
    }
  }, [data]);

  if (!data) return null;

  return (
    <div class="qr-display">
      {title && <h3 class="qr-title">{title}</h3>}
      <div class="qr-container">
        <canvas ref={canvasRef} class="qr-canvas" />
      </div>
    </div>
  );
}

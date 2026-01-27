import './ProgressBar.css';

interface ProgressBarProps {
  value: number; // 0-100
  label?: string;
  showPercentage?: boolean;
  variant?: 'default' | 'success' | 'error';
}

export function ProgressBar({
  value,
  label,
  showPercentage = true,
  variant = 'default',
}: ProgressBarProps) {
  const clampedValue = Math.max(0, Math.min(100, value));

  return (
    <div class="progress-wrapper">
      {(label || showPercentage) && (
        <div class="progress-header">
          {label && <span class="progress-label">{label}</span>}
          {showPercentage && <span class="progress-value">{Math.round(clampedValue)}%</span>}
        </div>
      )}
      <div class="progress-track">
        <div
          class={`progress-fill progress-${variant}`}
          style={{ width: `${clampedValue}%` }}
        />
      </div>
    </div>
  );
}

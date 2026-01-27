import './SignalMeter.css';

interface SignalMeterProps {
  level: number; // 0-100
  label?: string;
}

export function SignalMeter({ level, label }: SignalMeterProps) {
  const bars = 5;
  const activeThreshold = level / (100 / bars);

  return (
    <div class="signal-meter">
      {label && <span class="signal-label">{label}</span>}
      <div class="signal-bars">
        {Array.from({ length: bars }, (_, i) => (
          <div
            key={i}
            class={`signal-bar ${i < activeThreshold ? 'active' : ''}`}
            style={{ height: `${20 + i * 15}%` }}
          />
        ))}
      </div>
    </div>
  );
}

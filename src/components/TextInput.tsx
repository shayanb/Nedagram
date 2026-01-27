import './TextInput.css';

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  disabled?: boolean;
}

export function TextInput({
  value,
  onChange,
  placeholder,
  label,
  multiline = false,
  rows = 6,
  maxLength,
  disabled = false,
}: TextInputProps) {
  const handleChange = (e: Event) => {
    const target = e.target as HTMLInputElement | HTMLTextAreaElement;
    onChange(target.value);
  };

  const inputId = label ? `input-${label.replace(/\s+/g, '-').toLowerCase()}` : undefined;

  return (
    <div class="text-input-wrapper">
      {label && <label class="text-input-label" for={inputId}>{label}</label>}
      {multiline ? (
        <textarea
          id={inputId}
          class="text-input textarea"
          value={value}
          onInput={handleChange}
          placeholder={placeholder}
          rows={rows}
          maxLength={maxLength}
          disabled={disabled}
        />
      ) : (
        <input
          id={inputId}
          type="text"
          class="text-input"
          value={value}
          onInput={handleChange}
          placeholder={placeholder}
          maxLength={maxLength}
          disabled={disabled}
        />
      )}
    </div>
  );
}

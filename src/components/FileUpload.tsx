import { useRef } from 'preact/hooks';
import { Button } from './Button';
import './FileUpload.css';

interface FileUploadProps {
  onFileSelect: (content: string, filename: string) => void;
  label: string;
  accept?: string;
  disabled?: boolean;
}

export function FileUpload({
  onFileSelect,
  label,
  accept = '.txt,.json,.yaml,.yml,.conf,.ini,.toml,.xml,.env,.ovpn,.wgconf,.cert,.crt,.pem,.key',
  disabled = false,
}: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleChange = async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    try {
      const content = await file.text();
      onFileSelect(content, file.name);
    } catch (err) {
      console.error('Failed to read file:', err);
    }

    // Reset input so same file can be selected again
    target.value = '';
  };

  return (
    <div class="file-upload">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleChange}
        class="file-input"
        disabled={disabled}
      />
      <Button variant="secondary" onClick={handleClick} disabled={disabled}>
        <svg class="icon-start" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
        </svg>
        {label}
      </Button>
    </div>
  );
}

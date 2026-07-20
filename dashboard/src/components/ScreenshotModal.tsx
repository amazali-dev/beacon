import { useEffect } from 'react';

type Props = {
  src: string | null;
  alt?: string;
  onClose: () => void;
};

export function ScreenshotModal({ src, alt = 'Screenshot', onClose }: Props) {
  useEffect(() => {
    if (!src) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [src, onClose]);

  if (!src) return null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={alt}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <strong>{alt}</strong>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <img src={src} alt={alt} className="modal-image" />
        <footer className="modal-footer">
          <a href={src} target="_blank" rel="noreferrer">
            Open full size
          </a>
        </footer>
      </div>
    </div>
  );
}

type ThumbProps = {
  src: string | null | undefined;
  alt?: string;
  onOpen: (src: string) => void;
};

export function ScreenshotThumb({ src, alt = 'Screenshot', onOpen }: ThumbProps) {
  if (!src) return <span className="muted-text">—</span>;
  return (
    <button type="button" className="shot-thumb" onClick={() => onOpen(src)} title="Preview screenshot">
      <img src={src} alt={alt} />
      <span>Preview</span>
    </button>
  );
}

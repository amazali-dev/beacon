import { useEffect, useState } from 'react';

type Props = {
  src: string | null;
  alt?: string;
  onClose: () => void;
};

export function ScreenshotModal({ src, alt = 'Screenshot', onClose }: Props) {
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
  }, [src]);

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
        {broken ? (
          <p className="empty">
            Screenshot could not be loaded. This is not your website — the image link may be missing
            from storage, or an old row has no PNG.
          </p>
        ) : (
          <img
            src={src}
            alt={alt}
            className="modal-image"
            onError={() => setBroken(true)}
          />
        )}
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
  const [broken, setBroken] = useState(false);

  if (!src) return <span className="muted-text">—</span>;
  if (broken) {
    return <span className="muted-text">Screenshot unavailable</span>;
  }

  return (
    <button type="button" className="shot-thumb" onClick={() => onOpen(src)} title="Preview screenshot">
      <img src={src} alt={alt} onError={() => setBroken(true)} />
      <span>Preview</span>
    </button>
  );
}

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

function screenshotStoragePath(src: string): string | null {
  if (!src.startsWith('http')) return src.replace(/^screenshots\//, '');
  const marker = '/storage/v1/object/public/screenshots/';
  const index = src.indexOf(marker);
  return index >= 0 ? decodeURIComponent(src.slice(index + marker.length)) : null;
}

function useScreenshotUrl(src: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!src) {
      setUrl(null);
      return;
    }
    const path = screenshotStoragePath(src);
    if (!path) {
      setUrl(src);
      return;
    }
    void supabase.storage
      .from('screenshots')
      .createSignedUrl(path, 60 * 60)
      .then(({ data, error }) => {
        if (!cancelled) setUrl(error ? null : data.signedUrl);
      });
    return () => {
      cancelled = true;
    };
  }, [src]);
  return url;
}

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
  const resolvedSrc = useScreenshotUrl(src);

  useEffect(() => setBroken(false), [src]);

  if (!src) return <span className="muted-text">—</span>;
  if (!resolvedSrc) return <span className="muted-text">Loading screenshot…</span>;
  if (broken) {
    return <span className="muted-text">Screenshot unavailable</span>;
  }

  return (
    <button type="button" className="shot-thumb" onClick={() => onOpen(resolvedSrc)} title="Preview screenshot">
      <img src={resolvedSrc} alt={alt} onError={() => setBroken(true)} />
      <span>Preview</span>
    </button>
  );
}

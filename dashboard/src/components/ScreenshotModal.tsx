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
  label?: string;
  onOpen: (src: string) => void;
  className?: string;
};

export function ScreenshotThumb({
  src,
  alt = 'Screenshot',
  label = 'Preview',
  onOpen,
  className,
}: ThumbProps) {
  const [broken, setBroken] = useState(false);
  const resolvedSrc = useScreenshotUrl(src);

  useEffect(() => setBroken(false), [src]);

  if (!src) return <span className="muted-text">—</span>;
  if (!resolvedSrc) {
    return (
      <button type="button" className={`shot-thumb ${className || ''}`.trim()} disabled title="Loading screenshot">
        <span className="shot-thumb-frame is-loading">View</span>
        <span>{label}</span>
      </button>
    );
  }
  if (broken) {
    return <span className="muted-text">Screenshot unavailable</span>;
  }

  return (
    <button
      type="button"
      className={`shot-thumb ${className || ''}`.trim()}
      onClick={() => onOpen(resolvedSrc)}
      title="Preview screenshot"
    >
      <span className="shot-thumb-frame">
        <img src={resolvedSrc} alt={alt} onError={() => setBroken(true)} />
      </span>
      <span>{label}</span>
    </button>
  );
}

type AttProps = {
  src: string | null | undefined;
  label: string;
  alt?: string;
  onOpen: (src: string) => void;
};

/** Compact evidence chip (View / Att N) for incident cards. */
export function ScreenshotAttButton({ src, label, alt = 'Screenshot', onOpen }: AttProps) {
  const resolvedSrc = useScreenshotUrl(src);

  if (!src) return null;

  return (
    <button
      type="button"
      className="evidence-att"
      disabled={!resolvedSrc}
      title={alt}
      onClick={() => {
        if (resolvedSrc) onOpen(resolvedSrc);
      }}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
        <circle cx="5.5" cy="6" r="1.1" fill="currentColor" />
        <path d="M2.5 12.5 6 9l2.2 2.2L11 8.5l2.5 4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      </svg>
      <span>{resolvedSrc ? label : '…'}</span>
    </button>
  );
}

/** Prefer attempt_* paths; fall back to the single screenshot_path. */
export function collectScreenshotPaths(
  paths: Array<string | null | undefined> | null | undefined,
  primary?: string | null
): string[] {
  const ordered = [...(paths || []), primary];
  return Array.from(new Set(ordered.filter((path): path is string => Boolean(path))));
}

type EvidenceProps = {
  paths: string[];
  altBase: string;
  onOpen: (src: string, alt: string) => void;
  labels?: string[];
};

/** Shows one or more labeled screenshot thumbs (Attempt 1 / Attempt 2). */
export function ScreenshotEvidence({ paths, altBase, onOpen, labels }: EvidenceProps) {
  if (paths.length === 0) return <span className="muted-text">—</span>;
  if (paths.length === 1) {
    return (
      <ScreenshotThumb
        src={paths[0]}
        alt={altBase}
        onOpen={(src) => onOpen(src, altBase)}
      />
    );
  }

  return (
    <div className="incident-evidence">
      {paths.map((path, index) => {
        const label = labels?.[index] || `Attempt ${index + 1}`;
        const alt = `${altBase} — ${label}`;
        return (
          <div key={`${path}-${index}`}>
            <span>{label}</span>
            <ScreenshotThumb src={path} alt={alt} onOpen={(src) => onOpen(src, alt)} />
          </div>
        );
      })}
    </div>
  );
}

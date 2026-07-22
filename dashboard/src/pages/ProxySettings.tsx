import { useEffect, useMemo, useState } from 'react';
import { queueAndTriggerJob } from '../lib/operations';
import {
  loadProxyPoolStatus,
  parseProxyLines,
  removeProxy,
  saveProxyPool,
  type ProxyPoolStatus,
} from '../lib/proxies';

const SAMPLE = 'curl --proxy "http://username:password@proxy-host:80/" https://ipv4.webshare.io/';

export function ProxySettings() {
  const [status, setStatus] = useState<ProxyPoolStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(() => {
    if (!input.trim()) return { proxies: [], error: null };
    try {
      return { proxies: parseProxyLines(input), error: null };
    } catch (err) {
      return {
        proxies: [],
        error: err instanceof Error ? err.message : 'Could not parse proxy list',
      };
    }
  }, [input]);

  useEffect(() => {
    void loadProxyPoolStatus()
      .then((next) => {
        setStatus(next);
        setEnabled(next.enabled);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load proxy status'));
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (preview.error) throw new Error(preview.error);
      if (input.trim() && preview.proxies.length === 0) {
        throw new Error('No valid proxies were found.');
      }
      if (enabled && !input.trim() && (status?.proxyCount || 0) === 0) {
        throw new Error('Paste at least one proxy before enabling fallbacks.');
      }

      const next = await saveProxyPool(
        enabled,
        input.trim() ? preview.proxies : undefined
      );
      setStatus(next);
      setEnabled(next.enabled);
      setInput('');
      setMessage(
        input.trim()
          ? `${next.proxyCount} fallback ${next.proxyCount === 1 ? 'proxy is' : 'proxies are'} now saved encrypted.`
          : `Fallback proxies ${next.enabled ? 'enabled' : 'disabled'}; saved credentials were not changed.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save proxy settings');
    } finally {
      setBusy(false);
    }
  }

  async function testWithLoadCheck() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await queueAndTriggerJob('load_check');
      setMessage(
        'Load checks started. Each visit goes direct first; an HTTP 429 gets one fallback proxy attempt.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start load checks');
    } finally {
      setBusy(false);
    }
  }

  async function removeSavedProxy(proxyId: string, label: string) {
    if (!window.confirm(`Remove ${label} from the fallback pool?`)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await removeProxy(proxyId);
      setStatus(next);
      setEnabled(next.enabled);
      setMessage(`${label} removed. ${next.proxyCount} proxies remain.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove proxy');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>Fallback proxies</h1>
        <p>Encrypted proxy rotation for CDN rate limits. Credentials never appear again after save.</p>
      </div>

      {error && <p className="error">{error}</p>}
      {message && <p className="ok-msg">{message}</p>}

      <section className="ops-panel">
        <div className="proxy-status-row">
          <div>
            <span className="eyebrow">Current pool</span>
            <h2>{status ? `${status.proxyCount} saved` : 'Loading…'}</h2>
            <p className="section-hint">
              {status?.updatedAt
                ? `Last changed ${new Date(status.updatedAt).toLocaleString()}`
                : 'No proxy pool saved yet.'}
            </p>
          </div>
          <label className="proxy-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Use fallback pool
          </label>
        </div>
      </section>

      <section className="ops-panel">
        <h2>How attempts work</h2>
        <ol className="schedule-readonly">
          <li>
            <strong>Attempt 1 — preferred proxy:</strong> when the fallback pool is enabled,
            Beacon opens the site through a randomly chosen US proxy (prefers unused
            entries in the current run first).
          </li>
          <li>
            <strong>Attempt 2 — alternate path:</strong> if that path is rate-limited, one
            retry uses the other path (direct runner or another proxy). There are no further
            attempts.
          </li>
        </ol>
        <p className="section-hint">
          Each check picks a proxy at random from the healthy pool. HTTP 503 is never
          treated as a rate limit.
        </p>
      </section>

      {status?.proxies.length ? (
        <section className="ops-panel">
          <h2>Saved proxies</h2>
          <div className="proxy-saved-list">
            {status.proxies.map((proxy) => (
              <div key={proxy.id} className="proxy-saved-row">
                <div>
                  <strong>{proxy.label || 'Fallback proxy'}</strong>
                  <p className="meta">
                    {proxy.server}
                    {proxy.username_hint ? ` · user ${proxy.username_hint}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void removeSavedProxy(proxy.id, proxy.label || proxy.server)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="ops-panel">
        <h2>Add proxies</h2>
        <p className="section-hint">
          Paste one cURL command, proxy URL, or Geonix-style line per row
          (<code>host:port:username:password</code>). New proxies are added to the saved pool;
          matching server and username entries update their credentials. Leave it empty to only
          enable or disable the saved pool.
        </p>
        <textarea
          className="proxy-input"
          rows={8}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={`${SAMPLE}\nhttp://username:password@proxy-host:10000/\nproxy-host:10000:username:password`}
        />

        {input.trim() && (
          <div className={`proxy-preview ${preview.error ? 'invalid' : ''}`}>
            {preview.error ? (
              <p>{preview.error}</p>
            ) : (
              <>
                <strong>{preview.proxies.length} proxies ready</strong>
                <ul>
                  {preview.proxies.map((proxy) => (
                    <li key={proxy.id}>
                      {proxy.label}: <code>{proxy.server}</code>{' '}
                      {proxy.username ? '— credentials detected' : '— no username'}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        <div className="proxy-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Working…' : 'Save encrypted'}
          </button>
          <button
            type="button"
            disabled={busy || !status?.enabled || status.proxyCount === 0}
            onClick={() => void testWithLoadCheck()}
          >
            Run load check now
          </button>
        </div>
      </section>
    </div>
  );
}

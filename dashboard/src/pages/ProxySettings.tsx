import { useEffect, useMemo, useState } from 'react';
import { queueAndTriggerJob } from '../lib/operations';
import {
  loadProxyPoolStatus,
  parseProxyLines,
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
          ? `${next.proxyCount} fallback ${next.proxyCount === 1 ? 'proxy' : 'proxies'} saved encrypted.`
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
            <strong>Attempt 1 — direct:</strong> GitHub’s US runner visits the site normally.
          </li>
          <li>
            <strong>Attempt 2 — fallback:</strong> only an HTTP 429 selects one proxy from the
            rotating pool. There are no further attempts.
          </li>
        </ol>
        <p className="section-hint">
          Proxies rotate deterministically across sites, browser profiles, and scheduled runs.
          A proxy is not used for genuine HTTP 503 or other website failures.
        </p>
      </section>

      <section className="ops-panel">
        <h2>{status?.proxyCount ? 'Replace proxy pool' : 'Add proxy pool'}</h2>
        <p className="section-hint">
          Paste one cURL command or proxy URL per line, up to 10. Saving a non-empty list replaces
          the complete pool. Leave it empty to only enable or disable the saved pool.
        </p>
        <textarea
          className="proxy-input"
          rows={8}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={`${SAMPLE}\nhttp://username:password@another-proxy-host:80/`}
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

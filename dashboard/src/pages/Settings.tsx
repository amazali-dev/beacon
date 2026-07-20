import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { Site } from '../lib/types';

const emptyForm = {
  name: '',
  main_url: '',
  quote_form_url: '',
  extra_urls_text: '',
  form_testing_enabled: true,
  active: true,
};

export function Settings() {
  const [sites, setSites] = useState<Site[]>([]);
  const [mode, setMode] = useState<'list' | 'create' | 'edit'>('list');
  const [editing, setEditing] = useState<Site | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [message, setMessage] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  async function refresh() {
    const { data } = await supabase.from('sites').select('*').order('name');
    setSites((data || []) as Site[]);
  }

  useEffect(() => {
    void refresh();
  }, []);

  function startCreate() {
    setMode('create');
    setEditing(null);
    setForm(emptyForm);
    setMessage(null);
  }

  function startEdit(site: Site) {
    setMode('edit');
    setEditing(site);
    setMessage(null);
    setForm({
      name: site.name,
      main_url: site.main_url,
      quote_form_url: site.quote_form_url || '',
      extra_urls_text: (site.extra_urls || []).join('\n'),
      form_testing_enabled: site.form_testing_enabled,
      active: site.active,
    });
  }

  function cancelForm() {
    setMode('list');
    setEditing(null);
    setForm(emptyForm);
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    const payload = {
      name: form.name.trim(),
      main_url: form.main_url.trim(),
      quote_form_url: form.quote_form_url.trim() || null,
      extra_urls: form.extra_urls_text
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      form_testing_enabled: form.form_testing_enabled,
      active: form.active,
    };

    if (mode === 'edit' && editing) {
      const { error } = await supabase.from('sites').update(payload).eq('id', editing.id);
      if (error) {
        setMessage(error.message);
        return;
      }
      setMessage('Site updated. Changes apply on the next engine run (within ~30 minutes).');
    } else {
      const { error } = await supabase.from('sites').insert(payload);
      if (error) {
        setMessage(error.message);
        return;
      }
      setMessage(
        'Site added. On the next form-test run the engine will auto-detect form fields and report what it found.'
      );
    }
    cancelForm();
    await refresh();
  }

  async function removeSite(site: Site) {
    if (!confirm(`Remove ${site.name}? Past checks stay in the database unless you delete them separately.`)) {
      return;
    }
    await supabase.from('sites').delete().eq('id', site.id);
    await refresh();
  }

  return (
    <div>
      <div className="page-head">
        <h1>Sites</h1>
        <p>Add, edit, pause, or remove monitored sites. No code changes needed.</p>
      </div>

      {mode === 'list' && (
        <button type="button" className="primary" onClick={startCreate}>
          Add site
        </button>
      )}

      {mode !== 'list' && (
        <form className="settings-form" onSubmit={onSave}>
          <h2>{mode === 'edit' && editing ? `Edit ${editing.name}` : 'New site'}</h2>
          <label>
            Site name
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </label>
          <label>
            Main URL to monitor
            <input
              value={form.main_url}
              onChange={(e) => setForm({ ...form, main_url: e.target.value })}
              required
              placeholder="https://example.com/"
            />
          </label>
          <label>
            Get a Quote form page URL
            <input
              value={form.quote_form_url}
              onChange={(e) => setForm({ ...form, quote_form_url: e.target.value })}
              placeholder="Often a different page than the homepage"
            />
          </label>
          <label>
            Extra pages to monitor (one URL per line, optional)
            <textarea
              rows={3}
              value={form.extra_urls_text}
              onChange={(e) => setForm({ ...form, extra_urls_text: e.target.value })}
            />
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={form.form_testing_enabled}
              onChange={(e) =>
                setForm({ ...form, form_testing_enabled: e.target.checked })
              }
            />
            Form testing on
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
            />
            Site active (uncheck to pause)
          </label>

          {mode === 'edit' && editing && (
            <div className="advanced">
              <button
                type="button"
                className="linkish"
                onClick={() => setShowAdvanced((v) => !v)}
              >
                {showAdvanced ? 'Hide' : 'Show'} advanced selectors
              </button>
              {showAdvanced && (
                <pre className="code-block">
                  {JSON.stringify(
                    {
                      selectors: editing.selectors,
                      form_selectors: editing.form_selectors,
                      form_detection_status: editing.form_detection_status,
                    },
                    null,
                    2
                  )}
                </pre>
              )}
              {editing.form_detection_status &&
                Array.isArray(
                  (editing.form_detection_status as { plainEnglish?: string[] })
                    .plainEnglish
                ) && (
                  <ul className="detect-list">
                    {(
                      editing.form_detection_status as { plainEnglish: string[] }
                    ).plainEnglish.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
            </div>
          )}

          <div className="form-actions">
            <button type="submit" className="primary">
              Save
            </button>
            <button type="button" onClick={cancelForm}>
              Cancel
            </button>
          </div>
          {message && <p className="ok-msg">{message}</p>}
        </form>
      )}

      <div className="site-table table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Active</th>
              <th>Forms</th>
              <th>URL</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sites.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.active ? 'Yes' : 'Paused'}</td>
                <td>{s.form_testing_enabled ? 'On' : 'Off'}</td>
                <td className="url">
                  <a href={s.main_url} target="_blank" rel="noreferrer">
                    {s.main_url}
                  </a>
                </td>
                <td className="actions">
                  <Link className="subtle-link" to={`/site/${s.id}`}>
                    View
                  </Link>
                  <button type="button" onClick={() => startEdit(s)}>
                    Edit
                  </button>
                  <button type="button" className="danger" onClick={() => void removeSite(s)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {message && mode === 'list' && <p className="ok-msg">{message}</p>}
    </div>
  );
}

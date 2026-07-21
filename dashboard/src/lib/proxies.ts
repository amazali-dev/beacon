import { supabase } from './supabase';

export type ProxyCredential = {
  id: string;
  label: string;
  server: string;
  username?: string;
  password?: string;
};

export type ProxyPoolStatus = {
  enabled: boolean;
  proxyCount: number;
  updatedAt: string | null;
};

function extractProxyUrl(line: string): string {
  const trimmed = line.trim();
  const curlMatch = trimmed.match(/--proxy(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  return (curlMatch?.[1] || curlMatch?.[2] || curlMatch?.[3] || trimmed).trim();
}

export function parseProxyLines(raw: string): ProxyCredential[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length > 10) {
    throw new Error('Paste at most 10 proxies.');
  }

  return lines.map((line, index) => {
    const proxyUrl = extractProxyUrl(line);
    let parsed: URL;
    try {
      parsed = new URL(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(proxyUrl) ? proxyUrl : `http://${proxyUrl}`
      );
    } catch {
      throw new Error(`Proxy ${index + 1} is not a valid URL or cURL --proxy value.`);
    }

    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error(`Proxy ${index + 1} must use http:// or https://.`);
    }

    const port = parsed.port ? `:${parsed.port}` : '';
    const label = `Fallback ${index + 1}`;
    return {
      id: crypto.randomUUID(),
      label,
      server: `${parsed.protocol}//${parsed.hostname}${port}`,
      ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
      ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    };
  });
}

export async function loadProxyPoolStatus(): Promise<ProxyPoolStatus> {
  const { data, error } = await supabase
    .from('proxy_settings')
    .select('enabled,proxy_count,updated_at')
    .eq('singleton', true)
    .maybeSingle();

  if (error) {
    if (error.code === '42P01') {
      throw new Error('Proxy storage is not installed yet. Run migration 004 in Supabase first.');
    }
    throw new Error(error.message);
  }

  return {
    enabled: Boolean(data?.enabled),
    proxyCount: Number(data?.proxy_count || 0),
    updatedAt: data?.updated_at || null,
  };
}

export async function saveProxyPool(
  enabled: boolean,
  replacements?: ProxyCredential[]
): Promise<ProxyPoolStatus> {
  const { data, error } = await supabase.rpc('save_proxy_pool', {
    p_enabled: enabled,
    p_pool: replacements ?? null,
  });
  if (error) {
    if (error.code === 'PGRST202' || /save_proxy_pool/i.test(error.message)) {
      throw new Error('Proxy storage is not installed yet. Run migration 004 in Supabase first.');
    }
    throw new Error(error.message);
  }

  const result = data as { enabled?: boolean; proxy_count?: number } | null;
  return {
    enabled: Boolean(result?.enabled),
    proxyCount: Number(result?.proxy_count || 0),
    updatedAt: new Date().toISOString(),
  };
}

import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const allowedJobs = new Set(['load_check', 'form_test', 'detect_forms', 'daily_report']);

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const authHeader = request.headers.get('Authorization') || '';
    const url = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const githubToken = Deno.env.get('GITHUB_DISPATCH_TOKEN')!;
    const githubRepo = Deno.env.get('GITHUB_REPO') || 'amazali-dev/beacon';

    const authClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await authClient.auth.getUser();
    if (userError || !userData.user) {
      return Response.json({ error: 'Authentication required' }, { status: 401, headers: cors });
    }

    const { jobType, siteId = null } = await request.json();
    if (!allowedJobs.has(jobType)) {
      return Response.json({ error: 'Unsupported job type' }, { status: 400, headers: cors });
    }

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const cooldownSince = new Date(Date.now() - 5 * 60_000).toISOString();
    let recentQuery = admin
      .from('check_jobs')
      .select('id,status,requested_at')
      .eq('job_type', jobType)
      .gte('requested_at', cooldownSince)
      .in('status', ['pending', 'running']);
    recentQuery = siteId ? recentQuery.eq('site_id', siteId) : recentQuery.is('site_id', null);
    const { data: recent, error: recentError } = await recentQuery.limit(1);
    if (recentError) throw recentError;
    if (recent?.length) {
      return Response.json(
        { error: 'A matching job is already pending or running. Try again after five minutes.' },
        { status: 409, headers: cors }
      );
    }

    const { data: job, error: insertError } = await admin
      .from('check_jobs')
      .insert({ job_type: jobType, site_id: siteId })
      .select('id')
      .single();
    if (insertError) throw insertError;

    const dispatch = await fetch(
      `https://api.github.com/repos/${githubRepo}/actions/workflows/queued-jobs.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${githubToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );

    if (!dispatch.ok) {
      const detail = (await dispatch.text()).slice(0, 300);
      await admin
        .from('check_jobs')
        .update({ status: 'failed', completed_at: new Date().toISOString(), notes: detail })
        .eq('id', job.id);
      throw new Error(`GitHub dispatch failed (${dispatch.status})`);
    }

    return Response.json({ ok: true, jobId: job.id }, { headers: cors });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: cors }
    );
  }
});

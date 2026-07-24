import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

    const body = await request.json().catch(() => ({}));
    const jobId = typeof body.jobId === 'string' ? body.jobId : null;
    if (!jobId) {
      return Response.json({ error: 'jobId is required' }, { status: 400, headers: cors });
    }

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: job, error: jobError } = await admin
      .from('check_jobs')
      .select('id,status,github_run_id,cancel_requested_at')
      .eq('id', jobId)
      .maybeSingle();
    if (jobError) throw jobError;
    if (!job) {
      return Response.json({ error: 'Job not found' }, { status: 404, headers: cors });
    }

    if (!['pending', 'running'].includes(job.status)) {
      return Response.json(
        { ok: true, alreadyFinished: true, status: job.status },
        { headers: cors }
      );
    }

    const now = new Date().toISOString();
    const nextStatus = job.status === 'pending' ? 'cancelled' : job.status;
    const { error: updateError } = await admin
      .from('check_jobs')
      .update({
        cancel_requested_at: now,
        ...(job.status === 'pending'
          ? { status: 'cancelled', completed_at: now, notes: 'Cancelled before runner claimed the job' }
          : {}),
      })
      .eq('id', jobId)
      .in('status', ['pending', 'running']);
    if (updateError) throw updateError;

    let githubCancelled = false;
    let githubError: string | null = null;
    if (job.github_run_id) {
      const cancel = await fetch(
        `https://api.github.com/repos/${githubRepo}/actions/runs/${job.github_run_id}/cancel`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${githubToken}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );
      githubCancelled = cancel.ok;
      if (!cancel.ok) {
        githubError = (await cancel.text()).slice(0, 300);
      }
    }

    return Response.json(
      {
        ok: true,
        status: nextStatus === 'pending' ? 'cancelled' : 'cancel_requested',
        githubCancelled,
        githubError,
      },
      { headers: cors }
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: cors }
    );
  }
});

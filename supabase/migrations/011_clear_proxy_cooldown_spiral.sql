-- Clear proxy cooldown death spiral so fallbacks can be used again.
-- Safe: does not delete proxy credentials or proxy_settings.

update public.proxy_health
set blocked_until = null,
    updated_at = now();

-- Optional: confirm every migration is present in the ledger.
-- Expected versions: 001 … 010 (and later if already applied).
select version, name
from supabase_migrations.schema_migrations
order by version;

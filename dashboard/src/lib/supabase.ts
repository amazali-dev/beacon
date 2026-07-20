import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anon || url.includes('YOUR_') || anon.includes('YOUR_')) {
  console.error(
    'Beacon dashboard: missing Supabase keys.\n' +
      '1) Open dashboard/.env.local (create from .env.example)\n' +
      '2) Set VITE_SUPABASE_URL= your Project URL\n' +
      '3) Set VITE_SUPABASE_ANON_KEY= your anon public key (NOT service_role)\n' +
      '4) Restart: stop npm run dev (Ctrl+C) then run npm run dev again'
  );
}

export const supabase = createClient(
  url || 'http://localhost',
  anon || 'missing'
);

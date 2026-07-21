import { getEnv } from './config.js';

const kind = getEnv('PRECHECK_KIND', 'load');
const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

if (kind === 'form') {
  required.push('TEST_NAME', 'TEST_EMAIL', 'TEST_PHONE');
  if (getEnv('FORM_INBOX_VERIFICATION').toLowerCase() === 'true') {
    required.push('IMAP_HOST', 'IMAP_USER', 'IMAP_PASS');
  }
}

if (kind === 'report') {
  const hasResend = Boolean(getEnv('RESEND_API_KEY') && getEnv('REPORT_TO'));
  const hasSmtp = Boolean(getEnv('SMTP_HOST') && getEnv('SMTP_USER') && getEnv('SMTP_PASS') && getEnv('REPORT_TO'));
  if (!hasResend && !hasSmtp) {
    throw new Error('Daily report requires REPORT_TO plus Resend or SMTP credentials.');
  }
}

const missing = required.filter((name) => !getEnv(name));
if (missing.length) throw new Error(`Missing required production settings: ${missing.join(', ')}`);
console.log(`Production preflight passed for ${kind}.`);

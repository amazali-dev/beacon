/**
 * Layer 2 — read the test inbox via IMAP and look for the Run ID email.
 */

import { ImapFlow } from 'imapflow';
import { getEnv } from '../config.js';

export interface InboxResult {
  found: boolean;
  hasAttachment: boolean;
  delaySeconds: number | null;
  note: string | null;
}

export async function verifyInboxForRunId(
  runId: string,
  opts: {
    timeoutMinutes: number;
    requireAttachment: boolean;
    submittedAt: number;
  }
): Promise<InboxResult> {
  const host = getEnv('IMAP_HOST');
  const user = getEnv('IMAP_USER');
  const pass = getEnv('IMAP_PASS');
  const port = Number(getEnv('IMAP_PORT', '993'));

  if (!host || !user || !pass) {
    return {
      found: false,
      hasAttachment: false,
      delaySeconds: null,
      note: 'IMAP not configured (set IMAP_HOST, IMAP_USER, IMAP_PASS in .env)',
    };
  }

  const deadline = Date.now() + opts.timeoutMinutes * 60 * 1000;
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      while (Date.now() < deadline) {
        // Search recent messages
        const since = new Date(opts.submittedAt - 60_000);
        for await (const msg of client.fetch(
          { since },
          { envelope: true, bodyStructure: true, source: true, uid: true }
        )) {
          const subject = msg.envelope?.subject || '';
          const source = msg.source?.toString('utf8') || '';
          const haystack = `${subject}\n${source}`;
          if (!haystack.includes(runId)) continue;

          const hasAttachment = Boolean(
            msg.bodyStructure &&
              JSON.stringify(msg.bodyStructure).toLowerCase().includes('filename')
          );

          const delaySeconds = Math.max(
            0,
            Math.round((Date.now() - opts.submittedAt) / 1000)
          );

          return {
            found: true,
            hasAttachment,
            delaySeconds,
            note: hasAttachment
              ? null
              : 'Email found but no attachment detected',
          };
        }

        await new Promise((r) => setTimeout(r, 15_000));
      }
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }

  return {
    found: false,
    hasAttachment: false,
    delaySeconds: null,
    note: `No email containing Run ID ${runId} within ${opts.timeoutMinutes} minutes`,
  };
}

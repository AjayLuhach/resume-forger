// IMAP fetch. Ported from opening-tracker/services/emailFetcher.js, with the
// config taken per-operator from mongo instead of env (see CLAUDE.md's one rule).

import Imap from 'imap';
import { simpleParser } from 'mailparser';

// Gmail app passwords work for both SMTP and IMAP, so the stored SMTP block is
// enough; `emailConfig.imap` overrides host/port if a user is ever elsewhere.
export function imapConfigFor(user) {
  const smtp = user?.emailConfig?.smtp;
  if (!smtp?.user || !smtp?.pass) return null;
  const over = user.emailConfig.imap || {};
  return {
    user: over.user || smtp.user,
    password: over.pass || smtp.pass,
    host: over.host || 'imap.gmail.com',
    port: over.port || 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false, servername: over.host || 'imap.gmail.com' },
    authTimeout: 20000,
    connTimeout: 20000,
  };
}

function fetchBox(cfg, boxName, since) {
  return new Promise((resolve) => {
    const imap = new Imap(cfg);
    const out = [];
    const pending = [];
    let settled = false;
    let ok = true;                                   // false => degraded, do not reconcile on it
    const done = () => { if (!settled) { settled = true; resolve({ ok, emails: out }); } };
    const fail = () => { ok = false; done(); };

    imap.once('ready', () => {
      imap.openBox(boxName, true, (err) => {
        if (err) { imap.end(); return done(); }        // box absent is not a failure
        imap.search([['SINCE', since]], (err2, uids) => {
          if (err2) { imap.end(); return fail(); }
          if (!uids?.length) { imap.end(); return done(); }
          const f = imap.fetch(uids, { bodies: '', struct: true });
          f.on('message', (msg) => {
            let buf = '';
            msg.on('body', (s) => s.on('data', (c) => { buf += c.toString('utf8'); }));
            msg.once('end', () => {
              pending.push(
                simpleParser(buf)
                  .then((p) => {
                    out.push({
                      messageId: p.messageId || null,
                      inReplyTo: p.inReplyTo || null,
                      references: [].concat(p.references || []).filter(Boolean),
                      from: p.from?.text || '',
                      fromAddr: p.from?.value?.[0]?.address?.toLowerCase() || '',
                      to: p.to?.text || '',
                      subject: p.subject || '(no subject)',
                      body: (p.text || '').slice(0, 20000),   // bodies can be enormous
                      date: p.date?.toISOString() || new Date().toISOString(),
                      box: boxName,
                      hasAttachments: (p.attachments || []).length > 0,
                    });
                  })
                  .catch(() => {})                    // skip unparseable, keep the rest
              );
            });
          });
          f.once('error', () => { imap.end(); fail(); });
          f.once('end', () => { Promise.all(pending).then(() => { imap.end(); done(); }); });
        });
      });
    });
    imap.once('error', () => fail());
    imap.once('end', () => done());
    try { imap.connect(); } catch { fail(); }
  });
}

/** Fetch INBOX + Sent since `since` (Date). Sent is needed to see our own side of a thread. */
export async function fetchSince(user, since) {
  const cfg = imapConfigFor(user);
  if (!cfg) throw new Error('no SMTP/IMAP credentials on this user');
  const [inbox, sent] = await Promise.all([
    fetchBox(cfg, 'INBOX', since),
    fetchBox(cfg, '[Gmail]/Sent Mail', since),
  ]);
  // INBOX is the only box reconcile reasons about; a failed Sent fetch is
  // harmless, a failed INBOX fetch must never be read as "everything is gone".
  const complete = inbox.ok;
  const me = cfg.user.toLowerCase();
  const seen = new Set();
  const all = [];
  for (const m of [...inbox.emails, ...sent.emails]) {
    const key = m.messageId || `${m.date}|${m.subject}|${m.fromAddr}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push({ ...m, direction: m.fromAddr === me ? 'outbound' : 'inbound' });
  }
  all.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { mails: all, complete };
}

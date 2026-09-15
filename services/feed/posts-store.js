// Mongo-backed feed storage. Two collections:
//   posts        — the hiring-post pool (one row per LinkedIn postId)
//   user_emails  — email drafts (one row per username + postId)
import { col } from '../db.js';
import { normalizeCompany, parseSalaryToLPA } from './feed-filters.js';
import { userEmailsMirror, postsMirror } from '../mirror.js';

const POSTS = () => col('posts');
const USER_EMAILS = () => col('user_emails');

// After writing to Mongo, refresh the mirror with the post-write doc(s).
// Best-effort — failure here doesn't break the response, the periodic
// reconciler will eventually catch up.
const _refreshUserEmails = async (filter) => {
  try {
    const docs = await (await USER_EMAILS()).find(filter).toArray();
    if (docs.length) userEmailsMirror.applyMany(docs);
  } catch { /* mirror not loaded yet, skip */ }
};
const _refreshPosts = async (filter) => {
  try {
    const docs = await (await POSTS()).find(filter).toArray();
    if (docs.length) postsMirror.applyMany(docs);
  } catch { /* mirror not loaded yet, skip */ }
};

// ============================================================
// POSTS
// ============================================================

export const fetchExistingPostIds = async () => {
  const docs = await (await POSTS()).find({}, { projection: { postId: 1 } }).toArray();
  return new Set(docs.map(d => d.postId).filter(Boolean));
};

// When the post quoted no salary text but the model returned numbers, the
// label is synthesised in the candidate's own unit (preferences.salaryUnit)
// — the numeric fields keep their historical `…LPA` names whatever the unit.
const DEFAULT_SALARY_UNIT = 'LPA';
export const salaryLabelOf = (job, salaryUnit = DEFAULT_SALARY_UNIT) => {
  if (job?.salary) return job.salary;
  if (job?.salaryMinLPA == null) return '';
  const unit = String(salaryUnit || DEFAULT_SALARY_UNIT).trim();
  return job.salaryMaxLPA != null && job.salaryMaxLPA !== job.salaryMinLPA
    ? `${job.salaryMinLPA}-${job.salaryMaxLPA} ${unit}`
    : `${job.salaryMinLPA} ${unit}`;
};

export const pushPhase1Posts = async (extracted, originalPosts, addedBy = 'CLI', { salaryUnit } = {}) => {
  const existing = await fetchExistingPostIds();
  const lookup = new Map(originalPosts.map(p => [p.id, p]));
  const docs = [];
  let skipped = 0;
  for (const ex of extracted) {
    if (existing.has(ex.postId)) { skipped++; continue; }
    const o = lookup.get(ex.postId) || {};
    const company = ex.job?.company || '';
    const salaryStr = salaryLabelOf(ex.job, salaryUnit);
    const salaryMinLPA = ex.job?.salaryMinLPA ?? parseSalaryToLPA(salaryStr);
    docs.push({
      postId: ex.postId,
      addedBy,
      addedAt: new Date().toISOString(),
      poster: {
        name: ex.poster?.name || o.author?.name || '',
        // Parser value first: it is what was actually on the page. The AI's
        // copy is only ever an echo of the same string back through the prompt,
        // so it can degrade but never improve on it.
        headline: o.author?.headline || ex.poster?.headline || '',
        // 1st / 2nd / 3rd — decides whether outreach is a message or an invite.
        degree: o.author?.degree || null,
        profileUrl: o.author?.profileUrl || '',
      },
      postUrl: o.post?.url || '',
      postText: o.post?.text || '',
      summary: ex.summary || '',
      hashtags: o.post?.hashtags || [],
      job: {
        title: ex.job?.title || '',
        company,
        type: ex.job?.type || '',
        location: o.job?.location || '',
        requirements: ex.job?.requirements || [],
        requiredExperience: ex.job?.requiredExperience ?? null,
        salary: salaryStr,
        salaryMinLPA,
        salaryMaxLPA: ex.job?.salaryMaxLPA ?? null,
      },
      contacts: {
        emails: ex.contacts?.emails || [],
        links: (ex.contacts?.links?.length ? ex.contacts.links : (o.job?.jobUrl ? [o.job.jobUrl] : [])),
        method: ex.contacts?.method || (ex.contacts?.emails?.length ? 'email' : 'DM'),
      },
      status: 'hiring',
      notes: '',
      _companyKey: normalizeCompany(company),
    });
    existing.add(ex.postId);
  }
  if (docs.length) {
    // bulkWrite-upsert (not insertMany) so the col() Proxy adds $currentDate:
    // updatedAt — the server's 15 s delta sync needs that field or new posts
    // never reach its mirror (and "all already processed" never flips to
    // "fresh posts found").
    const c = await POSTS();
    const ops = docs.map((doc) => {
      const { postId, ...rest } = doc;
      return {
        updateOne: {
          filter: { postId },
          update: { $setOnInsert: rest },
          upsert: true,
        },
      };
    });
    await c.bulkWrite(ops, { ordered: false });
    await _refreshPosts({ postId: { $in: docs.map(d => d.postId) } });
  }
  console.log(`   📊 Mongo: ${docs.length} post(s) added, ${skipped} duplicate(s) skipped`);
  return { added: docs.length, skipped };
};

const _hydratePost = (d) => {
  const salary = d.job?.salary || '';
  let salaryMinLPA = d.job?.salaryMinLPA ?? null;
  let salaryMaxLPA = d.job?.salaryMaxLPA ?? null;
  if (salaryMinLPA == null && salary) {
    const m = salary.match(/([\d.]+)\s*-\s*([\d.]+)\s*LPA/i);
    if (m) { salaryMinLPA = parseFloat(m[1]); salaryMaxLPA = parseFloat(m[2]); }
  }
  const emails = d.contacts?.emails || [];
  const links = d.contacts?.links || [];
  return {
    postId: d.postId,
    addedBy: d.addedBy || '',
    addedAt: d.addedAt || '',
    poster: { name: d.poster?.name || '', headline: d.poster?.headline || '' },
    postText: d.postText || '',
    summary: d.summary || '',
    job: {
      title: d.job?.title || '',
      company: d.job?.company || '',
      type: d.job?.type || '',
      location: d.job?.location || '',
      requirements: d.job?.requirements || [],
      requiredExperience: d.job?.requiredExperience ?? null,
      salary: salary || null,
      salaryMinLPA,
      salaryMaxLPA,
    },
    contacts: {
      emails, links,
      method: d.contacts?.method || (emails.length ? 'email' : links.length ? 'link' : 'DM'),
    },
    status: (d.status || 'hiring').toLowerCase(),
  };
};

// Every post still marked hiring. There is no date cutoff: the whole pool
// belongs to the one operator, so the first `feed-cli emails` run scores all
// of it and later runs only see what fetchUserEmailPostIds hasn't claimed.
export const fetchHiringPosts = async () => {
  if (postsMirror.loaded) {
    const matched = postsMirror.filter((d) => d.status !== 'skipped');
    const posts = matched.map(_hydratePost);
    console.log(`   📊 Mirror: ${posts.length} hiring post(s) fetched`);
    return posts;
  }
  const docs = await (await POSTS()).find({ status: { $ne: 'skipped' } }).toArray();
  const posts = docs.map(_hydratePost);
  console.log(`   📊 Mongo: ${posts.length} hiring post(s) fetched`);
  return posts;
};

export const fetchAllPosts = async () => {
  if (postsMirror.loaded) {
    const posts = postsMirror.filter(() => true).map(_hydratePost);
    console.log(`   📊 Mirror: ${posts.length} total post(s) fetched`);
    return posts;
  }
  const docs = await (await POSTS()).find({}).toArray();
  const posts = docs.map(_hydratePost);
  console.log(`   📊 Mongo: ${posts.length} total post(s) fetched`);
  return posts;
};

export const updatePostStatus = async (postId, status) => {
  const r = await (await POSTS()).updateOne({ postId }, { $set: { status } });
  if (r.matchedCount > 0) await _refreshPosts({ postId });
  return r.matchedCount > 0;
};

export const batchUpdatePostStatuses = async (postIds, status) => {
  if (!postIds?.length) return { succeeded: [], failed: [] };
  const c = await POSTS();
  const found = new Set(
    (await c.find({ postId: { $in: postIds } }, { projection: { postId: 1 } }).toArray()).map(d => d.postId)
  );
  const succeeded = postIds.filter(id => found.has(id));
  const failed = postIds.filter(id => !found.has(id));
  if (succeeded.length) {
    await c.updateMany({ postId: { $in: succeeded } }, { $set: { status } });
    await _refreshPosts({ postId: { $in: succeeded } });
  }
  return { succeeded, failed };
};

// ============================================================
// USER EMAILS
// ============================================================

export const fetchUserEmailPostIds = async (username, opts = {}) => {
  if (userEmailsMirror.loaded) {
    const excl = opts.excludeStatuses?.length ? new Set(opts.excludeStatuses) : null;
    const out = new Set();
    for (const d of userEmailsMirror.iter()) {
      if (d.username !== username) continue;
      if (excl && excl.has(d.status)) continue;
      if (d.postId) out.add(d.postId);
    }
    return out;
  }
  const filter = { username };
  if (opts.excludeStatuses?.length) filter.status = { $nin: opts.excludeStatuses };
  const docs = await (await USER_EMAILS()).find(filter, { projection: { postId: 1 } }).toArray();
  return new Set(docs.map(d => d.postId).filter(Boolean));
};

export const pushUserEmails = async (username, contacts, opts = {}) => {
  const c = await USER_EMAILS();
  const existingIds = await fetchUserEmailPostIds(username);
  let drafted = new Set();
  if (opts.redraft) {
    const ds = await c.find({ username, status: 'drafted' }, { projection: { postId: 1 } }).toArray();
    drafted = new Set(ds.map(d => d.postId));
  }
  const inserts = [];
  let skipped = 0, updated = 0;
  for (const x of contacts) {
    if (existingIds.has(x.postId)) {
      if (opts.redraft && drafted.has(x.postId) && x.email?.body) {
        await c.updateOne(
          { username, postId: x.postId },
          { $set: {
            'email.to': x.email.to || '',
            'email.subject': x.email.subject || '',
            'email.body': x.email.body || '',
            status: 'drafted',
            approvedBy: '',
            generatedAt: new Date().toISOString(),
          }}
        );
        updated++;
        continue;
      }
      skipped++;
      continue;
    }
    const company = x.job?.company || '';
    const salaryStr = salaryLabelOf(x.job, opts.salaryUnit);
    const salaryMinLPA = x.job?.salaryMinLPA ?? parseSalaryToLPA(salaryStr);
    inserts.push({
      username,
      postId: x.postId,
      poster: { name: x.poster?.name || '', headline: x.poster?.headline || '' },
      job: {
        title: x.job?.title || '',
        company,
        type: x.job?.type || '',
        requirements: x.job?.requirements || [],
        requiredExperience: x.job?.requiredExperience ?? null,
        salary: salaryStr,
        salaryMinLPA,
      },
      score: x.match?.score ?? null,
      matchReason: x.match?.reason || '',
      email: {
        to: x.email?.to || '',
        subject: x.email?.subject || '',
        body: x.email?.body || '',
      },
      status: x.email?.body ? 'drafted' : 'no_email',
      approvedBy: '',
      generatedAt: new Date().toISOString(),
      sentAt: '',
      postSummary: x.summary || '',
      _companyKey: normalizeCompany(company),
    });
    existingIds.add(x.postId);
  }
  if (inserts.length) {
    // bulkWrite-upsert (not insertMany) so the col() Proxy in services/db.js
    // injects $currentDate: { updatedAt: true } — without that, the server's
    // 15s delta sync (find({ updatedAt: $gte })) never picks the new drafts
    // up and the Emails tab stays empty after a successful CLI run.
    const ops = inserts.map((doc) => {
      const { username: _u, postId: _p, ...rest } = doc;
      return {
        updateOne: {
          filter: { username: doc.username, postId: doc.postId },
          update: { $setOnInsert: rest },
          upsert: true,
        },
      };
    });
    await c.bulkWrite(ops, { ordered: false });
    await _refreshUserEmails({
      username,
      postId: { $in: inserts.map(d => d.postId) },
    });
  }
  const parts = [`${inserts.length} added`, `${skipped} skipped`];
  if (updated) parts.push(`${updated} re-drafted`);
  console.log(`   📊 ${username}: ${parts.join(', ')}`);
  return { added: inserts.length, skipped, updated };
};

// The tailor flow (/api/generate) drafts an email whenever the JD names a
// recruiter contact. It lands in the SAME collection as the outreach drafts,
// tagged source:'tailor', so the Emails page lists, approves, edits and sends
// it like any other draft — the send path attaches the tailored PDF via
// `variantId` instead of the master resume. One doc per generation; the
// synthetic postId keeps the (username, postId) key unique.
export const pushTailorEmail = async (username, { variantId, to, subject, body, jobTitle, jobCompany, contactName, score }) => {
  if (!username || !variantId || !to || !body) return null;
  const c = await USER_EMAILS();
  const postId = `tailor:${variantId}`;
  const company = jobCompany || '';
  const doc = {
    poster: { name: contactName || 'Recruiter', headline: company ? `Hiring at ${company}` : '' },
    job: {
      title: jobTitle || '',
      company,
      type: 'tailored',
      requirements: [],
      requiredExperience: null,
      salary: '',
      salaryMinLPA: null,
    },
    score: Number.isFinite(score) ? Math.round(score) : null,
    matchReason: 'Resume tailored to this job description',
    email: { to, subject: subject || '', body },
    status: 'drafted',
    approvedBy: '',
    generatedAt: new Date().toISOString(),
    sentAt: '',
    postSummary: '',
    source: 'tailor',
    variantId: String(variantId),
    _companyKey: normalizeCompany(company),
  };
  await c.updateOne({ username, postId }, { $setOnInsert: doc }, { upsert: true });
  await _refreshUserEmails({ username, postId });
  return postId;
};

const _hydrateUserEmail = (d) => ({
  postId: d.postId,
  source: d.source || 'feed',
  variantId: d.variantId || null,
  poster: { name: d.poster?.name || '', headline: d.poster?.headline || '' },
  job: {
    title: d.job?.title || '',
    company: d.job?.company || '',
    type: d.job?.type || '',
    experience: d.job?.requiredExperience != null ? String(d.job.requiredExperience) : '',
    salary: d.job?.salary || '',
  },
  requirements: (d.job?.requirements || []).join(', '),
  score: d.score ?? 0,
  matchReason: d.matchReason || '',
  email: { to: d.email?.to || '', subject: d.email?.subject || '', body: d.email?.body || '' },
  status: (d.status || '').toLowerCase(),
  approvedBy: d.approvedBy || '',
  generatedAt: d.generatedAt || '',
  sentAt: d.sentAt || '',
  postSummary: d.postSummary || '',
});

export const fetchUserEmails = async (username, statusFilter = null) => {
  const wantedStatus = statusFilter ? statusFilter.toLowerCase() : null;
  if (userEmailsMirror.loaded) {
    const matched = userEmailsMirror.filter((d) => {
      if (d.username !== username) return false;
      if (wantedStatus && (d.status || '').toLowerCase() !== wantedStatus) return false;
      return true;
    });
    return matched.map(_hydrateUserEmail);
  }
  const filter = { username };
  if (statusFilter) filter.status = statusFilter.toLowerCase();
  const docs = await (await USER_EMAILS()).find(filter).toArray();
  return docs.map(_hydrateUserEmail);
};

const _setUser = async (username, postId, set) => {
  const r = await (await USER_EMAILS()).updateOne({ username, postId }, { $set: set });
  if (r.matchedCount > 0) await _refreshUserEmails({ username, postId });
  return r.matchedCount > 0;
};

export const approveUserEmail = (username, postId, approvedBy) =>
  _setUser(username, postId, { status: 'approved', approvedBy });

export const rejectUserEmail = (username, postId) =>
  _setUser(username, postId, { status: 'rejected', approvedBy: '' });

export const unapproveUserEmail = (username, postId) =>
  _setUser(username, postId, { status: 'drafted', approvedBy: '' });

export const markUserEmailSent = (username, postId) =>
  _setUser(username, postId, { status: 'sent', sentAt: new Date().toISOString() });

export const updateUserEmailContent = (username, postId, { subject, body }) =>
  _setUser(username, postId, { 'email.subject': subject, 'email.body': body });

const _batchSet = async (username, postIds, set) => {
  if (!postIds?.length) return { succeeded: [], failed: [] };
  const c = await USER_EMAILS();
  const found = new Set(
    (await c.find({ username, postId: { $in: postIds } }, { projection: { postId: 1 } }).toArray()).map(d => d.postId)
  );
  const succeeded = postIds.filter(id => found.has(id));
  const failed = postIds.filter(id => !found.has(id));
  if (succeeded.length) {
    await c.updateMany({ username, postId: { $in: succeeded } }, { $set: set });
    await _refreshUserEmails({ username, postId: { $in: succeeded } });
  }
  return { succeeded, failed };
};

export const batchRejectUserEmails = (username, postIds) =>
  _batchSet(username, postIds, { status: 'rejected', approvedBy: '' });

export const batchApproveUserEmails = (username, postIds, approvedBy = 'Claude') =>
  _batchSet(username, postIds, { status: 'approved', approvedBy });

export const batchUpdateUserEmailContents = async (username, updates) => {
  if (!updates?.length) return { succeeded: [], failed: [] };
  const c = await USER_EMAILS();
  const ids = updates.map(u => u.postId);
  const found = new Set(
    (await c.find({ username, postId: { $in: ids } }, { projection: { postId: 1 } }).toArray()).map(d => d.postId)
  );
  const succeeded = [], failed = [];
  const ops = [];
  for (const { postId, subject, body } of updates) {
    if (!found.has(postId)) { failed.push(postId); continue; }
    ops.push({
      updateOne: {
        filter: { username, postId },
        update: { $set: { 'email.subject': subject, 'email.body': body } },
      },
    });
    succeeded.push(postId);
  }
  if (ops.length) {
    await c.bulkWrite(ops);
    await _refreshUserEmails({ username, postId: { $in: succeeded } });
  }
  return { succeeded, failed };
};

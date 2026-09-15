#!/usr/bin/env node

/**
 * Dashboard Server
 * Serves the feed page + mongo-backed API for the operator's email queue and
 * the hiring-post pool.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import {
  fetchUserEmails,
  approveUserEmail,
  rejectUserEmail,
  unapproveUserEmail,
  updateUserEmailContent,
  batchRejectUserEmails,
  batchApproveUserEmails,
  batchUpdateUserEmailContents,
  fetchAllPosts,
  updatePostStatus,
  batchUpdatePostStatuses,
} from '../../services/feed/posts-store.js';
import { contentDisposition } from '../../services/content-disposition.js';
import { col } from '../../services/db.js';
import { buildEmailsFilter, buildPostsFilter, buildEmailsMatcher, buildPostsMatcher } from '../../services/feed/feed-filters.js';
import { userEmailsMirror, postsMirror } from '../../services/mirror.js';
import { loadAll as loadHighSalary } from '../../services/feed/high-salary-store.js';
import * as feedCaptureBuffer from '../../services/feed/feed-capture-buffer.js';
import { getUnprocessedPosts } from '../../services/feed/extract-store.js';
import { skillMatcher } from '../../services/feed/skill-match.js';
import { loadCandidate } from '../../services/feed/feed-config.js';

// A feed profile changes only when the operator edits their resume, but the
// posts list would otherwise re-read it from Atlas on every keystroke of the
// search box. Cached per username; the /api/resume/* save paths in server.js
// call invalidateFeedCandidate() so an edit on /resume.html shows up on the
// next request, and a short TTL covers any write that path does not see.
const CANDIDATE_TTL_MS = 60_000;
const _candidateCache = new Map();   // username -> { candidate, at }
const loadFeedCandidate = async (username) => {
  const hit = _candidateCache.get(username);
  if (hit && Date.now() - hit.at < CANDIDATE_TTL_MS) return hit.candidate;
  const candidate = await loadCandidate(username);
  _candidateCache.set(username, { candidate, at: Date.now() });
  return candidate;
};
export const invalidateFeedCandidate = (username = null) => {
  if (username == null) _candidateCache.clear();
  else _candidateCache.delete(username);
};

// Live send runs, keyed by username. In-process: a restart mid-batch loses the
// handle, same trade-off tailor-batch.js documents.
const sendRuns = new Map();
// One Curl Feed run at a time — concurrent pulls would interleave startIndex.
let curlRun = null;

const FEED_MIRROR = true;
const emailsReady = () => FEED_MIRROR && userEmailsMirror.loaded;
const postsReady  = () => FEED_MIRROR && postsMirror.loaded;
import { getUser, upsertResumeData, setUserPdf, getUserPdf, listVariants, getVariantPdf } from '../../services/resume-store.js';
import { resolveUsername } from '../../services/users/current.js';

// Operator = the user whose identity the feed routes act under. Mounted in
// server.js, requests are auth-gated first, so the session cookie is the
// authoritative source; a request with no cookie (none in practice)
// and falls through to the sole user in `users`. There is no query or body
// override — see services/users/current.js.
const resolveOperator = (req) => resolveUsername(req);

// Two things gate "Generate emails": a feed resume with a skills map (the
// scorer has nothing to match without one) and SMTP credentials (drafts
// nobody can send are noise). Shared by the GET that drives the button and
// the POST that runs the job, so the UI and the guard can never disagree.
const eligibilityFor = async (username) => {
  const usersCol = await col('users');
  const d = await usersCol.findOne(
    { username },
    { projection: { username: 1, 'feedData.personalInfo.name': 1, 'feedData.skills': 1, 'emailConfig.smtp': 1 } },
  );
  const skillCount = d?.feedData?.skills && typeof d.feedData.skills === 'object'
    ? Object.keys(d.feedData.skills).length : 0;
  const hasFeedResume = !!d?.feedData?.personalInfo?.name && skillCount > 0;
  const smtp = d?.emailConfig?.smtp || {};
  const hasSmtp = !!(smtp.host && smtp.user && smtp.pass);
  const reasons = [];
  if (!hasFeedResume) reasons.push(skillCount === 0 ? 'no feed skills' : 'no feed resume');
  if (!hasSmtp) reasons.push('no SMTP config');
  return { username, skillCount, hasFeedResume, hasSmtp, eligible: hasFeedResume && hasSmtp, reasons };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/feed/ → climb two levels to reach the repo root.
const ROOT = path.join(__dirname, '..', '..');

// Lazy one-shot index ensure for the feed collections. Filtering by
// {status, username} and sorting by score is the hot path for the dashboard
// — without these, every list call full-scans the collection and sorts in
// memory (the 7-second status=sent queries we saw before).
let _feedIndexed = false;
// Swallow benign collisions when an index with the same key already exists,
// regardless of whether the existing spec differs by name OR by options
// (e.g. an older `postId_1` was created without `sparse: true`). We don't
// want a one-off historical mismatch to wedge the whole feed page.
const _safe = async (c, keys, opts) => {
  try { await c.createIndex(keys, opts); }
  catch (e) {
    if (/already exists/i.test(e.message)) return;
    throw e;
  }
};
const ensureFeedIndexes = async () => {
  if (_feedIndexed) return;
  const [ue, ps] = await Promise.all([col('user_emails'), col('posts')]);
  await Promise.all([
    // user_emails — list pages sort by score within a status, so a
    // compound (status, score desc) lets mongo serve the page from index.
    _safe(ue, { status: 1, score: -1 }),
    _safe(ue, { username: 1, status: 1 }),
    _safe(ue, { _companyKey: 1 }),
    _safe(ue, { postId: 1 }),
    // posts — list pages sort by addedAt within a status.
    _safe(ps, { status: 1, addedAt: -1 }),
    _safe(ps, { addedAt: -1 }),
    _safe(ps, { _companyKey: 1 }),
    // Existing `postId_1` is `{ unique: true }` without sparse — match it so
    // re-running this code on a fresh DB still applies uniqueness, but we
    // don't try to rewrite the option set on the live one.
    _safe(ps, { postId: 1 }, { unique: true }),
  ]);
  _feedIndexed = true;
};


const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function parseUrl(url) {
  const [pathname, qs] = url.split('?');
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  return { pathname, params };
}

// Exposed as middleware. When `next` is passed, unmatched paths defer to the
// outer Express app (so the static handler can serve /feed.html).
export const feedHandler = async (req, res, next) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const { pathname, params } = parseUrl(req.url);

  try {
    // GET /api/config-user — the operator the feed routes act under.
    if (req.method === 'GET' && pathname === '/api/config-user') {
      const me = await resolveOperator(req);
      return json(res, 200, { name: me });
    }

    // GET /api/feed/stats?view=emails|posts — stat-card numbers.
    // Independent of filter chips (those scope the list, not the totals).
    // The emails view always counts the operator's own rows.
    if (req.method === 'GET' && pathname === '/api/feed/stats') {
      const view = params.view || 'emails';
      if (view === 'posts') {
        const ps = await col('posts');
        const [agg] = await ps.aggregate([{
          $facet: {
            total: [{ $count: 'n' }],
            byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
            byMethod: [{ $group: { _id: '$contacts.method', count: { $sum: 1 } } }],
          },
        }]).toArray();
        const status = Object.fromEntries(agg.byStatus.map(r => [r._id || 'hiring', r.count]));
        const method = Object.fromEntries(agg.byMethod.map(r => [r._id || 'DM', r.count]));
        return json(res, 200, {
          total: agg.total[0]?.n || 0,
          hiring: status.hiring || 0,
          skipped: status.skipped || 0,
          withEmail: method.email || 0,
          withLink: method.link || 0,
          dmOnly: method.DM || 0,
        });
      }
      // emails
      const operator = await resolveOperator(req);
      if (!operator) return json(res, 401, { error: 'Not authenticated' });
      const ue = await col('user_emails');
      const baseFilter = { username: operator };
      const [agg] = await ue.aggregate([
        { $match: baseFilter },
        { $facet: {
          total: [{ $count: 'n' }],
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          avgScore: [{ $group: { _id: null, avg: { $avg: '$score' } } }],
        }},
      ]).toArray();
      const status = Object.fromEntries(agg.byStatus.map(r => [r._id || 'drafted', r.count]));
      return json(res, 200, {
        total: agg.total[0]?.n || 0,
        drafted: status.drafted || 0,
        approved: status.approved || 0,
        sent: status.sent || 0,
        rejected: status.rejected || 0,
        no_email: status.no_email || 0,
        avgScore: agg.avgScore[0]?.avg || 0,
      });
    }

    // GET /api/feed?view=emails|posts&status=&type=&minSalary=&hasEmail=&contactMethod=&wellKnown=&q=&limit=
    // Filtered list. Server-side: matching, sorting, capping. Client just renders.
    // The emails view is always scoped to the operator's own rows.
    if (req.method === 'GET' && pathname === '/api/feed') {
      await ensureFeedIndexes();
      const view = params.view || 'emails';
      const limit = Math.max(1, Math.min(parseInt(params.limit) || 200, 2000));

      if (view === 'posts') {
        // The pool has no score of its own — scoring lives on `user_emails`.
        // Attach the viewer's score/status so a post row can show how it
        // rated without a second round trip.
        const viewer = await resolveOperator(req);
        const scoreOf = new Map();
        if (viewer && userEmailsMirror.loaded) {
          for (const e of userEmailsMirror.iter()) {
            if (e.username === viewer && e.postId) {
              scoreOf.set(e.postId, { score: e.score ?? null, emailStatus: e.status || null });
            }
          }
        }
        // Which of the post's requirements this viewer can and can't claim.
        // Computed here rather than asked of the model: the requirement list is
        // already extracted and the candidate's skills are already known, so the
        // gap is a set operation — free, retroactive across the whole pool, and
        // guaranteed to agree with the score rendered beside it (same matcher).
        let matcher = null;
        if (viewer) {
          try { matcher = skillMatcher(await loadFeedCandidate(viewer)); }
          catch { /* no feed profile for this user — cards just omit the gap */ }
        }
        // The viewer's connect state for each poster, so the card shows
        // Pending instead of Connect and Auto-connect never reopens a
        // profile LinkedIn already confirmed.
        const { connectStateByProfile, profileKey } = await import('../../services/feed/connects-store.js');
        const connectOf = viewer ? await connectStateByProfile(viewer) : new Map();

        const withScore = (d) => {
          const { _companyKey, ...rest } = d;
          const s = scoreOf.get(d.postId);
          const out = s ? { ...rest, ...s } : rest;
          if (matcher) out.skills = matcher.split(d.job?.requirements || []);
          const c = connectOf.get(profileKey(d.poster?.profileUrl));
          if (c) out.connect = c;
          return out;
        };

        // Sorting by score has to happen HERE, over the whole filtered set —
        // the score isn't on the post, it's joined per viewer above. Sorting
        // client-side would only order the 200-row page, so the best-matching
        // post in a 600-row result could never reach the top.
        // Both sortable fields are "present or not": a post can be unscored,
        // and a post can state no experience requirement. Missing values read
        // as null rather than a sentinel number — a sentinel that sinks a row
        // under descending order floats it to the top under ascending, burying
        // exactly the rows the sort exists to surface.
        const SORTS = {
          score:    { get: (d) => scoreOf.get(d.postId)?.score, dir: -1 },
          scoreAsc: { get: (d) => scoreOf.get(d.postId)?.score, dir: 1 },
          exp:      { get: (d) => d.job?.requiredExperience,    dir: 1 },   // least demanding first
          expDesc:  { get: (d) => d.job?.requiredExperience,    dir: -1 },
        };
        const spec = SORTS[params.sort] || null;
        const rank = (d) => {
          const v = spec.get(d);
          return Number.isFinite(v) ? v : null;
        };
        // Rows missing the field go last in BOTH directions; the rest compare
        // on it, and ties fall through to the caller's addedAt ordering.
        const cmpRank = (a, b) => {
          const ra = rank(a), rb = rank(b);
          if (ra === null && rb === null) return 0;
          if (ra === null) return 1;
          if (rb === null) return -1;
          return (ra - rb) * spec.dir;
        };

        // ── Mirror path ──
        if (postsReady()) {
          const match = buildPostsMatcher(params);
          const matched = postsMirror.filter(match);
          // Same sort semantics as Mongo: status-order asc (hiring=0, skipped=1)
          // then addedAt desc. For a single-status filter, all rows have the
          // same order so the comparator collapses to addedAt desc.
          matched.sort((a, b) => {
            const oa = a.status === 'skipped' ? 1 : 0;
            const ob = b.status === 'skipped' ? 1 : 0;
            if (oa !== ob) return oa - ob;
            if (spec) {
              const d = cmpRank(a, b);
              if (d !== 0) return d;   // newest first within an equal band
            }
            return (b.addedAt || '').localeCompare(a.addedAt || '');
          });
          const items = matched.slice(0, limit).map(withScore);
          return json(res, 200, { items, totalFiltered: matched.length });
        }
        const ps = await col('posts');
        const filter = buildPostsFilter(params);
        // When a specific status is filtered, drop the synthetic _statusOrder
        // step — Mongo can then use the (status, addedAt -1) index to serve
        // the page directly without computing a derived field on every doc.
        const singleStatus = filter.$and?.some(c => c.status === 'hiring' || c.status === 'skipped');
        const pipeline = singleStatus
          ? [
              { $match: filter },
              { $sort: { addedAt: -1 } },
              { $limit: limit },
              { $project: { _companyKey: 0 } },
            ]
          : [
              { $match: filter },
              { $addFields: { _statusOrder: { $cond: [{ $eq: ['$status', 'skipped'] }, 1, 0] } } },
              { $sort: { _statusOrder: 1, addedAt: -1 } },
              { $limit: limit },
              { $project: { _statusOrder: 0, _companyKey: 0 } },
            ];
        const rowsFromMongo = await ps.aggregate(pipeline).toArray();
        // Score lives on user_emails, not on the post, so Mongo can't sort by
        // it — this orders the fetched page only. Acceptable because this
        // branch runs solely in the sub-second window before the mirror loads;
        // the mirror path above sorts the whole filtered set correctly.
        if (spec) rowsFromMongo.sort(cmpRank);
        const items = rowsFromMongo.map(withScore);
        const totalFiltered = items.length === limit
          ? await ps.countDocuments(filter)
          : items.length;
        return json(res, 200, { items, totalFiltered });
      }

      // Emails — the matcher and the Mongo filter both read `params.user`,
      // which is pinned to the operator here rather than taken from the query.
      const operator = await resolveOperator(req);
      if (!operator) return json(res, 401, { error: 'Not authenticated' });
      params.user = operator;

      // ── Mirror path for emails ──
      if (emailsReady()) {
        const match = buildEmailsMatcher(params);
        const matched = userEmailsMirror.filter(match);
        // Sort: status-order asc (drafted, approved, sent, rejected, no_email),
        // then score desc. With a status filter, the first comparator is a no-op.
        const ORDER = { drafted: 0, approved: 1, sent: 2, rejected: 3, no_email: 4 };
        matched.sort((a, b) => {
          const oa = ORDER[a.status] ?? 5;
          const ob = ORDER[b.status] ?? 5;
          if (oa !== ob) return oa - ob;
          return (b.score ?? 0) - (a.score ?? 0);
        });
        const page = matched.slice(0, limit);

        // Distinct postIds across the full filtered set — single Set pass.
        const distinct = new Set();
        for (const d of matched) if (d.postId) distinct.add(d.postId);

        // postText join — pull from posts mirror if available, else hit Mongo
        // (rare; only during the small window where posts mirror is still loading).
        const pagePostIds = [...new Set(page.map(d => d.postId).filter(Boolean))];
        const postTextMap = {};
        if (pagePostIds.length) {
          if (postsReady()) {
            for (const pid of pagePostIds) {
              const p = postsMirror.all().find(p => p.postId === pid);
              if (p) postTextMap[pid] = p.postText || '';
            }
          } else {
            const ps = await col('posts');
            const postDocs = await ps.find(
              { postId: { $in: pagePostIds } },
              { projection: { postId: 1, postText: 1 } },
            ).toArray();
            for (const p of postDocs) postTextMap[p.postId] = p.postText || '';
          }
        }

        const reshaped = page.map((d) => ({
          postId: d.postId,
          _user: d.username,
          source: d.source || 'feed',
          variantId: d.variantId || null,
          poster: d.poster || { name: '', headline: '' },
          job: {
            title: d.job?.title || '',
            company: d.job?.company || '',
            type: d.job?.type || '',
            experience: d.job?.requiredExperience != null ? String(d.job.requiredExperience) : '',
            salary: d.job?.salary || '',
            salaryMinLPA: d.job?.salaryMinLPA ?? null,
          },
          requirements: (d.job?.requirements || []).join(', '),
          score: d.score ?? 0,
          matchReason: d.matchReason || '',
          email: d.email || { to: '', subject: '', body: '' },
          status: (d.status || 'drafted').toLowerCase(),
          approvedBy: d.approvedBy || '',
          generatedAt: d.generatedAt || '',
          sentAt: d.sentAt || '',
          postSummary: d.postSummary || '',
          postText: postTextMap[d.postId] || '',
        }));
        return json(res, 200, { items: reshaped, totalFiltered: matched.length, totalFilteredPosts: distinct.size });
      }

      // emails — return both totalFiltered (matching emails) and totalFilteredPosts
      // (distinct postIds) so the result-count line reflects exact backend totals.
      const ue = await col('user_emails');
      const filter = buildEmailsFilter(params);
      const reqStatus = params.status && params.status !== 'all' ? params.status : null;
      const emailsPipeline = reqStatus
        ? [
            // Single-status path: index (status, score -1) serves filter + sort.
            { $match: filter },
            { $sort: { score: -1 } },
            { $limit: limit },
            { $project: { _companyKey: 0 } },
          ]
        : [
            { $match: filter },
            { $addFields: { _statusOrder: { $switch: { branches: [
              { case: { $eq: ['$status', 'drafted'] }, then: 0 },
              { case: { $eq: ['$status', 'approved'] }, then: 1 },
              { case: { $eq: ['$status', 'sent'] }, then: 2 },
              { case: { $eq: ['$status', 'rejected'] }, then: 3 },
              { case: { $eq: ['$status', 'no_email'] }, then: 4 },
            ], default: 5 } } } },
            { $sort: { _statusOrder: 1, score: -1 } },
            { $limit: limit },
            { $project: { _statusOrder: 0, _companyKey: 0 } },
          ];
      // Three things in parallel: the page, the email count, and the
      // distinct-postId count. The previous version did the latter two
      // inside a single $facet with $group + $count, which forced mongo
      // to scan every matching doc in user space — multi-second on
      // status=sent. countDocuments() and distinct() are both native
      // commands that hit indexes directly, much cheaper than $group.
      const [items, totalFiltered, distinctPostIds] = await Promise.all([
        ue.aggregate(emailsPipeline).toArray(),
        ue.countDocuments(filter),
        ue.distinct('postId', filter),
      ]);
      const totalFilteredPosts = distinctPostIds.length;

      // Fetch postText for just the postIds in this page — keeps "Original Post"
      // available in the card without shipping the entire posts collection.
      const postIds = [...new Set(items.map(d => d.postId).filter(Boolean))];
      const postTextMap = {};
      if (postIds.length) {
        const ps = await col('posts');
        const postDocs = await ps.find(
          { postId: { $in: postIds } },
          { projection: { postId: 1, postText: 1 } },
        ).toArray();
        for (const p of postDocs) postTextMap[p.postId] = p.postText || '';
      }

      // Reshape to match the legacy fetchUserEmails return shape that the dashboard already consumes.
      const reshaped = items.map((d) => ({
        postId: d.postId,
        _user: d.username,
        source: d.source || 'feed',
        variantId: d.variantId || null,
        poster: d.poster || { name: '', headline: '' },
        job: {
          title: d.job?.title || '',
          company: d.job?.company || '',
          type: d.job?.type || '',
          experience: d.job?.requiredExperience != null ? String(d.job.requiredExperience) : '',
          salary: d.job?.salary || '',
          salaryMinLPA: d.job?.salaryMinLPA ?? null,
        },
        requirements: (d.job?.requirements || []).join(', '),
        score: d.score ?? 0,
        matchReason: d.matchReason || '',
        email: d.email || { to: '', subject: '', body: '' },
        status: (d.status || 'drafted').toLowerCase(),
        approvedBy: d.approvedBy || '',
        generatedAt: d.generatedAt || '',
        sentAt: d.sentAt || '',
        postSummary: d.postSummary || '',
        postText: postTextMap[d.postId] || '',
      }));
      return json(res, 200, { items: reshaped, totalFiltered, totalFilteredPosts });
    }

    // GET /api/emails[?status=&includePostText=1] — the operator's drafts in
    // the fetchUserEmails shape. includePostText=1 joins each row's original
    // post text (reviewers read a draft against it).
    if (req.method === 'GET' && pathname === '/api/emails') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });
      const emails = await fetchUserEmails(user, params.status || null);
      if (params.includePostText === '1' && emails.length) {
        const ids = new Set(emails.map((e) => e.postId).filter(Boolean));
        const textMap = {};
        if (postsReady()) {
          for (const p of postsMirror.iter()) if (ids.has(p.postId)) textMap[p.postId] = p.postText || '';
        } else {
          const docs = await (await col('posts')).find(
            { postId: { $in: [...ids] } },
            { projection: { postId: 1, postText: 1 } },
          ).toArray();
          for (const p of docs) textMap[p.postId] = p.postText || '';
        }
        for (const e of emails) e.postText = textMap[e.postId] || '';
      }
      return json(res, 200, { user, emails });
    }

    // POST /api/approve — { postId, approvedBy? }
    if (req.method === 'POST' && pathname === '/api/approve') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });
      const body = JSON.parse(await readBody(req));
      if (!body.postId) return json(res, 400, { error: 'Missing postId' });
      const ok = await approveUserEmail(user, body.postId, body.approvedBy || 'Dashboard');
      if (!ok) return json(res, 404, { error: 'Email not found' });
      return json(res, 200, { ok: true });
    }

    // POST /api/reject — { postId }
    if (req.method === 'POST' && pathname === '/api/reject') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });
      const body = JSON.parse(await readBody(req));
      if (!body.postId) return json(res, 400, { error: 'Missing postId' });
      const ok = await rejectUserEmail(user, body.postId);
      if (!ok) return json(res, 404, { error: 'Email not found' });
      return json(res, 200, { ok: true });
    }

    // POST /api/emails/update — { postId, subject, body }
    if (req.method === 'POST' && pathname === '/api/emails/update') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });
      const body = JSON.parse(await readBody(req));
      if (!body.postId) return json(res, 400, { error: 'Missing postId' });
      if (body.subject == null || body.body == null) return json(res, 400, { error: 'Missing subject or body' });
      const ok = await updateUserEmailContent(user, body.postId, { subject: body.subject, body: body.body });
      if (!ok) return json(res, 404, { error: 'Email not found' });
      return json(res, 200, { ok: true });
    }

    // POST /api/unapprove — { postId }
    if (req.method === 'POST' && pathname === '/api/unapprove') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });
      const body = JSON.parse(await readBody(req));
      if (!body.postId) return json(res, 400, { error: 'Missing postId' });
      const ok = await unapproveUserEmail(user, body.postId);
      if (!ok) return json(res, 404, { error: 'Email not found' });
      return json(res, 200, { ok: true });
    }

    // POST /api/batch — batch reject/approve/update in one round-trip.
    // Body: { reject: [postId…], approve: [postId…], update: [{ postId, subject, body }…] }
    // Response: { reject: { succeeded, failed }, approve: {…}, update: {…} }
    if (req.method === 'POST' && pathname === '/api/batch') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });
      const body = JSON.parse(await readBody(req));
      const list = (x) => (Array.isArray(x) ? x : []);
      const results = {
        reject: await batchRejectUserEmails(user, list(body.reject)),
        approve: await batchApproveUserEmails(user, list(body.approve), 'Claude'),
        update: await batchUpdateUserEmailContents(user, list(body.update)),
      };
      return json(res, 200, results);
    }

    // GET /api/high-salary — was high-salary-companies.json on disk;
    // now mongo `high_salary_companies` (mirrored). Sub-ms in steady state.
    if (req.method === 'GET' && pathname === '/api/high-salary') {
      const data = await loadHighSalary();
      // Strip mongo _id / timestamps from the wire shape so the UI keeps
      // matching against the same fields the legacy JSON had.
      const companies = data.map(({ _id, createdAt, updatedAt, ...rest }) => rest);
      return json(res, 200, { companies });
    }

    // GET /api/posts — fetch all posts from shared Posts tab
    if (req.method === 'GET' && pathname === '/api/posts') {
      const posts = await fetchAllPosts();
      return json(res, 200, { posts });
    }

    // POST /api/posts/skip — { postId } or { postIds: [...] }
    if (req.method === 'POST' && pathname === '/api/posts/skip') {
      const body = JSON.parse(await readBody(req));
      if (body.postIds) {
        const result = await batchUpdatePostStatuses(body.postIds, 'skipped');
        return json(res, 200, result);
      }
      if (!body.postId) return json(res, 400, { error: 'Missing postId or postIds' });
      const ok = await updatePostStatus(body.postId, 'skipped');
      if (!ok) return json(res, 404, { error: 'Post not found' });
      return json(res, 200, { ok: true });
    }

    // POST /api/posts/restore — { postId } or { postIds: [...] }
    if (req.method === 'POST' && pathname === '/api/posts/restore') {
      const body = JSON.parse(await readBody(req));
      if (body.postIds) {
        const result = await batchUpdatePostStatuses(body.postIds, 'hiring');
        return json(res, 200, result);
      }
      if (!body.postId) return json(res, 400, { error: 'Missing postId or postIds' });
      const ok = await updatePostStatus(body.postId, 'hiring');
      if (!ok) return json(res, 404, { error: 'Post not found' });
      return json(res, 200, { ok: true });
    }

    // ── Connection-request queue ────────────────────────────────────────
    // The outreach path for DM-only posts. See services/feed/connects-store.js
    // for why it is three states rather than a single "sent" flag.

    // GET /api/connects?status=&limit= — the operator's queue + status counts
    if (req.method === 'GET' && pathname === '/api/connects') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });
      const { listConnects, connectCounts, messageUrlFor } = await import('../../services/feed/connects-store.js');
      const limit = Math.max(1, Math.min(parseInt(params.limit) || 200, 1000));
      const [{ items, total }, counts] = await Promise.all([
        listConnects({ username: user, status: params.status || null, limit }),
        connectCounts(user),
      ]);
      // messageUrl is derived, not stored — the fsd urn lives on the scraped
      // connection row and only exists once they've accepted.
      return json(res, 200, {
        items: items.map((r) => ({ ...r, messageUrl: messageUrlFor(r) })),
        total,
        counts,
      });
    }

    // POST /api/connects/invite — { postId } or { postIds: [...] }
    // Records that an invitation was sent. LinkedIn has no API for sending it,
    // so the UI opens the profile and this marks our side of it.
    if (req.method === 'POST' && pathname === '/api/connects/invite') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });
      const body = JSON.parse(await readBody(req));
      const ids = body.postIds || (body.postId ? [body.postId] : []);
      if (!ids.length) return json(res, 400, { error: 'Missing postId or postIds' });

      const { queueConnect } = await import('../../services/feed/connects-store.js');
      const posts = postsReady()
        ? postsMirror.all().filter((p) => ids.includes(p.postId))
        : await (await col('posts')).find({ postId: { $in: ids } }).toArray();

      const saved = [];
      const failed = [];
      for (const p of posts) {
        try { saved.push(await queueConnect({ username: user, post: p })); }
        catch (e) { failed.push({ postId: p.postId, error: e.message }); }
      }
      // Posts with no profile URL never make it into `posts` above being
      // actionable — report them so the UI doesn't silently drop a click.
      for (const id of ids) {
        if (!posts.some((p) => p.postId === id)) failed.push({ postId: id, error: 'post not found' });
      }
      return json(res, 200, { saved: saved.length, failed });
    }

    // POST /api/connects/status — { postId, status, message? }
    if (req.method === 'POST' && pathname === '/api/connects/status') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });
      const body = JSON.parse(await readBody(req));
      if (!body.postId || !body.status) return json(res, 400, { error: 'Missing postId or status' });
      const { setConnectStatus } = await import('../../services/feed/connects-store.js');
      try {
        const row = await setConnectStatus({
          username: user, postId: body.postId, status: body.status, message: body.message,
        });
        return json(res, 200, { ok: true, row });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // POST /api/connects/draft — { postIds: [...] }
    // Drafts follow-up messages for accepted connections and stores them.
    if (req.method === 'POST' && pathname === '/api/connects/draft') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });
      const body = JSON.parse(await readBody(req));
      const ids = body.postIds || (body.postId ? [body.postId] : []);
      if (!ids.length) return json(res, 400, { error: 'Missing postIds' });

      const { getConnect, saveConnectMessage } = await import('../../services/feed/connects-store.js');
      const { draftConnectMessages } = await import('../../services/feed/connect-message.js');

      const rows = (await Promise.all(ids.map((id) => getConnect({ username: user, postId: id })))).filter(Boolean);
      if (!rows.length) return json(res, 404, { error: 'no queued rows for those posts' });

      const candidate = await loadCandidate(user);
      // Batched so one model call covers the whole selection, the same way
      // phase-3 email drafting works.
      const drafted = await draftConnectMessages(rows, candidate);
      const out = [];
      for (const [postId, message] of drafted) {
        out.push(await saveConnectMessage({ username: user, postId, message }));
      }
      return json(res, 200, { drafted: out.length, items: out });
    }

    // GET /api/email-eligibility — { username, skillCount, hasFeedResume,
    // hasSmtp, eligible, reasons } for the operator. The Generate-emails UI
    // uses it to decide whether the [Run] button is enabled and why not.
    if (req.method === 'GET' && pathname === '/api/email-eligibility') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });
      return json(res, 200, await eligibilityFor(user));
    }

    // POST /api/generate-emails — spawn `node scripts/feed/feed-cli.js emails --user
    // <operator>` and stream its output via SSE.
    if (req.method === 'POST' && pathname === '/api/generate-emails') {
      const user = await resolveOperator(req);
      if (!user) {
        return json(res, 401, { error: 'Not authenticated' });
      }
      // Final guard: the same check the GET above drives the button with.
      const elig = await eligibilityFor(user);
      if (!elig.eligible) {
        return json(res, 400, {
          error: `User "${user}" not eligible: ${elig.reasons.join(', ')}`,
          hasFeedResume: elig.hasFeedResume, hasSmtp: elig.hasSmtp, reasons: elig.reasons,
        });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const sendSSE = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      const onData = (chunk) => {
        for (const line of chunk.toString().split('\n').filter(l => l.trim())) {
          sendSSE({ stage: 'emails', message: line.trim() });
        }
      };

      sendSSE({ stage: 'emails', banner: true, message: `▶ generating emails for ${user}…` });

      const child = spawn('node', ['scripts/feed/feed-cli.js', 'emails', '--user', user], {
        cwd: ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('close', (code) => {
        sendSSE({ stage: 'emails', banner: true, message: `✓ emails exited (code=${code})`, done: true, code });
        res.end();
      });
      child.on('error', (err) => {
        sendSSE({ stage: 'emails', error: err.message, done: true, code: 1 });
        res.end();
      });
      req.on('close', () => child.kill());
      return;
    }

    // POST /api/parse-and-generate — run `scripts/feed/feed-cli.js parse` then
    // `scripts/feed/feed-cli.js generate --user <operator>` in sequence, streaming
    // combined stdout/stderr via SSE. The generate step needs the operator
    // for the `addedBy` field on `posts`. If parse exits non-zero, generate
    // is NOT started.
    if (req.method === 'POST' && pathname === '/api/parse-and-generate') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const sendSSE = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      const onData = (label) => (chunk) => {
        for (const line of chunk.toString().split('\n').filter(l => l.trim())) {
          sendSSE({ stage: label, message: line.trim() });
        }
      };

      // Sequentially spawn the two CLI commands. The second only runs if
      // the first exited 0. Cleanup on early client disconnect.
      const steps = [
        { label: 'parse',    args: ['scripts/feed/feed-cli.js', 'parse'] },
        { label: 'generate', args: ['scripts/feed/feed-cli.js', 'generate', '--user', user] },
      ];
      let cancelled = false;
      let activeChild = null;

      const runStep = (step) => new Promise((resolve) => {
        sendSSE({ stage: step.label, message: `▶ starting ${step.label}…`, banner: true });
        const child = spawn('node', step.args, {
          cwd: ROOT,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        activeChild = child;
        child.stdout.on('data', onData(step.label));
        child.stderr.on('data', onData(step.label));
        child.on('close', (code) => {
          sendSSE({ stage: step.label, message: `✓ ${step.label} exited (code=${code})`, banner: true, code });
          resolve(code);
        });
        child.on('error', (err) => {
          sendSSE({ stage: step.label, error: err.message });
          resolve(1);
        });
      });

      req.on('close', () => {
        cancelled = true;
        if (activeChild) activeChild.kill();
      });

      (async () => {
        for (const step of steps) {
          if (cancelled) break;
          const code = await runStep(step);
          if (code !== 0) {
            sendSSE({ done: true, code, stoppedAt: step.label });
            res.end();
            return;
          }
        }
        if (!cancelled) {
          sendSSE({ done: true, code: 0 });
          res.end();
        }
      })();

      return;
    }

    // POST /api/capture-parse — parse the in-memory feed-capture buffer into
    // extract.json (real activity ids, NO AI). The buffer is NEVER cleared here
    // — pages stay until "Clear captured" (marked banked; only evicted under
    // memory pressure once safely saved). Re-Loading just re-dedups.
    if (req.method === 'POST' && pathname === '/api/capture-parse') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });
      let pr;
      try { pr = feedCaptureBuffer.parseAndStore(); }
      catch (e) { return json(res, 500, { error: e.message }); }
      // Captured pages but parsed nothing → likely a new format. Dump a raw
      // sample to output/ (gitignored) so the parser can be debugged.
      try {
        if (pr.parsed === 0 && pr.counts.chunkCount > 0) {
          fs.writeFileSync(path.join(ROOT, 'output', 'feed-capture-raw.json'), JSON.stringify(feedCaptureBuffer.dump(2, 8_000_000), null, 2));
        }
      } catch { /* non-fatal */ }
      let pending = 0;
      try { pending = getUnprocessedPosts().length; } catch {}
      return json(res, 200, { ...pr, pending });
    }

    // POST /api/feed-generate — the "Analyze" step: run
    // `scripts/feed/feed-cli.js generate --user <operator>` (AI Phase 1) over the
    // accumulated unprocessed posts → mongo `posts`. SSE-streamed.
    if (req.method === 'POST' && pathname === '/api/feed-generate') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const sendSSE = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

      let cancelled = false;
      let activeChild = null;
      req.on('close', () => { cancelled = true; if (activeChild) activeChild.kill(); });

      const code = await new Promise((resolve) => {
        sendSSE({ stage: 'generate', message: `▶ analyzing posts (as ${user})…`, banner: true });
        const child = spawn('node', ['scripts/feed/feed-cli.js', 'generate', '--user', user], {
          cwd: ROOT,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        activeChild = child;
        const onData = (chunk) => {
          for (const line of chunk.toString().split('\n').filter(l => l.trim())) {
            sendSSE({ stage: 'generate', message: line.trim() });
          }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('close', (c) => { sendSSE({ stage: 'generate', message: `✓ generate exited (code=${c})`, banner: true, code: c }); resolve(c); });
        child.on('error', (err) => { sendSSE({ stage: 'generate', error: err.message }); resolve(1); });
      });

      if (!cancelled) { sendSSE({ done: true, code }); res.end(); }
      return;
    }

    // POST /api/send-emails — start (or re-attach to) a send run.
    //
    // The run is DETACHED from the request: a 50-email batch takes ~2 hours at
    // the 120-155s pacing in send-emails.js, and closing the tab used to kill
    // it mid-batch. Same run-registry shape as services/apply/tailor-batch.js,
    // which rejected SSE-owned children for exactly this reason.
    //
    // Re-POSTing while a run is live ATTACHES to it rather than spawning a
    // second — two children on one SMTP account would double-send.
    if (req.method === 'POST' && pathname === '/api/send-emails') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const sendSSE = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ } };

      let run = sendRuns.get(user);
      if (run && !run.done) {
        // Replay what they missed, then follow along.
        sendSSE({ message: `— attached to a run already in progress (started ${new Date(run.startedAt).toLocaleTimeString()})` });
        for (const line of run.lines) sendSSE({ message: line });
      } else {
        const child = spawn('node', [path.join(__dirname, 'send-emails.js'), '--user', user], {
          cwd: ROOT,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,             // survives this request, and this process's exit
        });
        child.unref();
        run = { user, child, lines: [], listeners: new Set(), done: false, code: null, startedAt: Date.now() };
        sendRuns.set(user, run);

        const onData = (chunk) => {
          for (const line of chunk.toString().split('\n').filter((l) => l.trim())) {
            const msg = line.trim();
            run.lines.push(msg);
            if (run.lines.length > 2000) run.lines.shift();   // bound the buffer on long batches
            for (const fn of run.listeners) fn({ message: msg });
          }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('close', (code) => {
          run.done = true; run.code = code;
          for (const fn of run.listeners) fn({ done: true, code });
          run.listeners.clear();
        });
        child.on('error', (err) => {
          run.done = true; run.code = 1; run.error = err.message;
          for (const fn of run.listeners) fn({ error: err.message, done: true, code: 1 });
          run.listeners.clear();
        });
      }

      run.listeners.add(sendSSE);
      if (run.done) { sendSSE({ done: true, code: run.code }); res.end(); return; }
      // Detach the writer only — the child keeps going.
      req.on('close', () => { run.listeners.delete(sendSSE); });
      return;
    }

    // ── Curl Feed ─────────────────────────────────────────────────────────
    // Fetch content-search pages directly instead of scrolling. Detached like
    // the send run: a 500-post pull outlives any one browser tab.
    if (req.method === 'POST' && pathname === '/api/curl-feed/start') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });
      if (curlRun && !curlRun.done) return json(res, 409, { error: 'a run is already in progress' });

      const body = JSON.parse(await readBody(req) || '{}');
      const terms = (body.terms || []).map(String).filter(Boolean);
      const perTerm = Math.max(10, Math.min(Number(body.perTerm) || 250, 1000));
      if (!terms.length) return json(res, 400, { error: 'no search terms' });

      const { runCurlFeed, parseCurl } = await import('../../services/feed/curl-feed.js');
      const creds = parseCurl(body.curl);
      if (!creds.ok) return json(res, 400, { error: `curl is missing: ${creds.missing.join(', ')}` });

      const ctrl = new AbortController();
      curlRun = { lines: [], done: false, error: null, startedAt: Date.now(), progress: null, ctrl, summary: null };
      const onEvent = (e) => {
        if (e.message) { curlRun.lines.push(e.message); if (curlRun.lines.length > 500) curlRun.lines.shift(); }
        if (e.progress) curlRun.progress = e.progress;
      };
      runCurlFeed({ curl: body.curl, terms, perTerm, onEvent, signal: ctrl.signal })
        .then((sum) => { curlRun.summary = sum; curlRun.done = true; })
        .catch((e) => { curlRun.error = e.message; curlRun.done = true; onEvent({ message: 'failed: ' + e.message }); });

      return json(res, 200, { ok: true, started: true, terms, perTerm });
    }

    if (req.method === 'GET' && pathname === '/api/curl-feed/status') {
      if (!(await resolveOperator(req))) return json(res, 401, { error: 'Not authenticated' });
      if (!curlRun) return json(res, 200, { active: false, lines: [] });
      return json(res, 200, {
        active: !curlRun.done, done: curlRun.done, error: curlRun.error,
        startedAt: curlRun.startedAt, progress: curlRun.progress,
        summary: curlRun.summary, lines: curlRun.lines.slice(-120),
      });
    }

    if (req.method === 'POST' && pathname === '/api/curl-feed/stop') {
      if (!(await resolveOperator(req))) return json(res, 401, { error: 'Not authenticated' });
      if (curlRun && !curlRun.done) curlRun.ctrl.abort();
      return json(res, 200, { ok: true });
    }

    // Clear only what Curl Feed staged — the unprocessed rows it appended.
    if (req.method === 'POST' && pathname === '/api/curl-feed/clear') {
      if (!(await resolveOperator(req))) return json(res, 401, { error: 'Not authenticated' });
      const { loadExtract, saveExtract } = await import('../../services/feed/extract-store.js');
      const data = loadExtract();
      const before = (data.posts || []).length;
      data.posts = (data.posts || []).filter((p) => !(p.source === 'sdui' && !p.processed));
      saveExtract(data);
      curlRun = null;
      return json(res, 200, { ok: true, removed: before - data.posts.length, remaining: data.posts.length });
    }

    // GET /api/send-emails/run — poll a detached run after a reload.
    if (req.method === 'GET' && pathname === '/api/send-emails/run') {
      const user = await resolveOperator(req);
      if (!user) return json(res, 401, { error: 'Not authenticated' });
      const run = sendRuns.get(user);
      if (!run) return json(res, 200, { active: false });
      return json(res, 200, {
        active: !run.done, done: run.done, code: run.code, error: run.error || null,
        startedAt: run.startedAt, lines: run.lines.slice(-200),
      });
    }

    // ============================================================
    // RESUME — the operator's JSON + PDF storage
    // ============================================================

    const resumeUser = await resolveOperator(req);

    // GET /api/resume — returns the resume JSON (no PDF buffer) plus PDF metadata.
    if (req.method === 'GET' && pathname === '/api/resume') {
      if (!resumeUser) return json(res, 401, { error: 'Not authenticated' });
      const doc = await getUser(resumeUser);
      if (!doc) return json(res, 404, { error: `No resume for "${resumeUser}"` });
      return json(res, 200, {
        username: doc.username,
        data: doc.data || null,
        pdf: doc.pdf ? {
          filename: doc.pdf.filename,
          contentType: doc.pdf.contentType,
          size: doc.pdf.size,
          updatedAt: doc.pdf.updatedAt,
        } : null,
        updatedAt: doc.updatedAt,
      });
    }

    // GET /api/candidate — full candidate context for workflow tooling
    // (used by tooling). Returns BOTH the deep tailor `data` and the
    // slim outreach `feedData`, so review-emails.md etc. can load everything
    // they need in one shot. No auth secrets, no PDF blob, no history rings.
    if (req.method === 'GET' && pathname === '/api/candidate') {
      if (!resumeUser) return json(res, 401, { error: 'Not authenticated' });
      const doc = await getUser(resumeUser);
      if (!doc) return json(res, 404, { error: `No user "${resumeUser}"` });
      return json(res, 200, {
        username: doc.username,
        data: doc.data || null,
        feedData: doc.feedData || null,
        updatedAt: doc.updatedAt || null,
      });
    }

    // PUT /api/resume — replace the resume JSON for the user.
    if (req.method === 'PUT' && pathname === '/api/resume') {
      if (!resumeUser) return json(res, 400, { error: 'No user' });
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Invalid JSON body' }); }
      if (!body || typeof body !== 'object') return json(res, 400, { error: 'Body must be a JSON object' });
      if (!body.personalInfo?.name) return json(res, 400, { error: 'personalInfo.name required' });
      const r = await upsertResumeData(resumeUser, body);
      invalidateFeedCandidate(resumeUser);
      return json(res, 200, { ok: true, ...r });
    }

    // GET /api/resume/pdf — stream the stored PDF.
    if (req.method === 'GET' && pathname === '/api/resume/pdf') {
      if (!resumeUser) return json(res, 400, { error: 'No user' });
      const pdf = await getUserPdf(resumeUser);
      if (!pdf) return json(res, 404, { error: `No PDF for "${resumeUser}"` });
      res.writeHead(200, {
        'Content-Type': pdf.contentType || 'application/pdf',
        'Content-Disposition': contentDisposition('inline', pdf.filename),
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(pdf.buffer);
    }

    // GET /api/resume/variants?limit=N — tailored resume variants
    // produced by resume-tailor. PDF blobs omitted from list payload.
    if (req.method === 'GET' && pathname === '/api/resume/variants') {
      if (!resumeUser) return json(res, 400, { error: 'No user' });
      const limit = Math.max(1, Math.min(parseInt(params.limit) || 50, 200));
      const variants = await listVariants(resumeUser, { limit });
      return json(res, 200, { variants });
    }

    // GET /api/resume/variants/:id/pdf — stream a single variant's PDF.
    if (req.method === 'GET' && pathname.startsWith('/api/resume/variants/') && pathname.endsWith('/pdf')) {
      const id = pathname.split('/')[4];
      const pdf = await getVariantPdf(id);
      if (!pdf) return json(res, 404, { error: 'Variant or PDF not found' });
      res.writeHead(200, {
        'Content-Type': pdf.contentType || 'application/pdf',
        'Content-Disposition': contentDisposition('inline', pdf.filename),
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(pdf.buffer);
    }

    // POST /api/resume/pdf — upload a PDF (raw binary, Content-Type: application/pdf).
    // Filename comes from ?filename=. ~16MB BSON cap; 5MB ceiling here is well within.
    if (req.method === 'POST' && pathname === '/api/resume/pdf') {
      if (!resumeUser) return json(res, 400, { error: 'No user' });
      const buffer = await readBodyBuffer(req);
      if (!buffer.length) return json(res, 400, { error: 'Empty body' });
      if (buffer.length > 5 * 1024 * 1024) return json(res, 413, { error: 'PDF must be < 5MB' });
      // Quick magic-byte check — first 4 bytes of a PDF are "%PDF".
      if (buffer.slice(0, 4).toString() !== '%PDF') return json(res, 400, { error: 'Body is not a PDF' });
      const filename = (params.filename || 'resume.pdf').replace(/[^A-Za-z0-9._-]/g, '_');
      await setUserPdf(resumeUser, {
        filename,
        contentType: 'application/pdf',
        buffer,
      });
      return json(res, 200, { ok: true, filename, size: buffer.length });
    }

    // Unmatched API path. When mounted in Express, fall through so the outer
    // static handler can serve /feed.html etc.
    if (typeof next === 'function') return next();
    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(`Feed API error: ${req.method} ${req.url} — ${err.stack || err.message}`);
    json(res, 500, { error: err.message });
  }
};

// This module exports `feedHandler` to be mounted by server.js behind the
// auth gate. Standalone mode was removed when identity flipped to "comes
// from the session cookie" — running this file directly would skip auth.

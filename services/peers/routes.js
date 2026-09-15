// HTTP surface for peer job sources, mounted by server.js at
// /api/settings/peers — after the auth gate and after the global body
// parser, so nothing here re-checks the session or parses JSON.
//
//   GET    /            → { peers: [redacted + state], local: { host, db } }
//   POST   /            → 201 { peer, test }   (only after a successful test)
//   PUT    /:id         → { peer }
//   DELETE /:id?purge=1 → { ok, purged }
//   POST   /:id/test    → test result
//   POST   /:id/sync    → sync result
//   POST   /sync        → { results }
//
// Connection strings come in on POST / PUT and never go back out: every
// response carries the redacted form only.
import { Router } from 'express';
import {
  readPeers, getPeer, addPeer, updatePeer, removePeer, patchPeerState,
  publicPeer, validatePeerInput, checkPeerKey, PeerConfigError, scrubMessage, localIdentity,
} from './peers-config.js';
import { testPeer, syncPeer, syncAll, purgePeerRows, closePeerClient, withPeerRemoval } from './peer-sync.js';
import { log } from '../log.js';

const router = Router();

const sendError = (res, e) => {
  if (e instanceof PeerConfigError) return res.status(e.status).json({ error: e.message, code: e.code });
  log.warn('peers', `route error: ${scrubMessage(e.message)}`);
  return res.status(500).json({ error: scrubMessage(e.message) || 'Internal error' });
};

// One test at a time: each opens a fresh connection to someone else's
// cluster with 8 s timeouts, and a double-click would open two.
let _testing = false;
const withTestSlot = async (res, fn) => {
  if (_testing) return res.status(409).json({ error: 'Another test is running — try again in a moment', code: 'busy' });
  _testing = true;
  try { return await fn(); } finally { _testing = false; }
};

router.get('/', (_req, res) => {
  try {
    res.json({ peers: readPeers().peers.map(publicPeer), local: localIdentity() });
  } catch (e) { sendError(res, e); }
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  try {
    const v = validatePeerInput(body);
    checkPeerKey(v.key, { peers: readPeers().peers });
  } catch (e) { return sendError(res, e); }

  return withTestSlot(res, async () => {
    const test = await testPeer(body);
    if (!test.ok) return res.status(400).json({ error: test.hint, code: test.code, test });
    try {
      const peer = addPeer(body);
      if (test.remoteAnalyzedCount != null) patchPeerState(peer.id, { remoteAnalyzedCount: test.remoteAnalyzedCount });
      // First pull straight away so the apply page fills within seconds
      // rather than on the next 30 s tick. Fire-and-forget: the response
      // is the add, not the import.
      syncPeer(peer.id).catch((e) => log.warn('peers', `${peer.label}: first sync failed: ${scrubMessage(e.message)}`));
      return res.status(201).json({ peer: publicPeer(getPeer(peer.id) || peer), test });
    } catch (e) { return sendError(res, e); }
  });
});

router.put('/:id', async (req, res) => {
  try {
    const r = updatePeer(req.params.id, req.body || {});
    if (!r) return res.status(404).json({ error: 'Unknown peer' });
    const { peer, changed } = r;
    // A changed uri needs a new client; a disabled peer should hold no
    // connection open to someone else's cluster.
    if (changed.uri || changed.db || changed.key || !peer.enabled) await closePeerClient(peer.id);
    if (changed.enabled && peer.enabled) {
      syncPeer(peer.id).catch(() => {});
    }
    res.json({ peer: publicPeer(peer), changed });
  } catch (e) { sendError(res, e); }
});

// Purge first, remove second: a purge that fails (Atlas timeout) leaves the
// peer configured so the operator can retry — removing it first would mint
// a new id on re-add and orphan the rows for good. withPeerRemoval holds
// off the sync loop so a batch in flight cannot land rows after the purge.
router.delete('/:id', async (req, res) => {
  try {
    const purge = ['1', 'true', 'yes'].includes(String(req.query.purge || '').toLowerCase());
    const peer = getPeer(req.params.id);
    if (!peer) return res.status(404).json({ error: 'Unknown peer' });
    const purged = await withPeerRemoval(peer.id, async () => {
      const n = purge ? await purgePeerRows(peer.id, peer.label) : 0;
      removePeer(peer.id);
      return n;
    });
    res.json({ ok: true, purged });
  } catch (e) { sendError(res, e); }
});

router.post('/:id/test', async (req, res) => {
  if (!getPeer(req.params.id)) return res.status(404).json({ error: 'Unknown peer' });
  return withTestSlot(res, async () => {
    try {
      res.json(await testPeer(req.params.id));
    } catch (e) { sendError(res, e); }
  });
});

router.post('/:id/sync', async (req, res) => {
  try {
    const r = await syncPeer(req.params.id, { manual: true });
    if (r.code === 'not-found') return res.status(404).json({ error: r.hint, code: r.code });
    if (r.code === 'in-flight') return res.status(409).json({ error: r.hint, code: r.code });
    res.json({ ...r, peer: publicPeer(getPeer(req.params.id)) });
  } catch (e) { sendError(res, e); }
});

router.post('/sync', async (_req, res) => {
  try {
    const r = await syncAll();
    if (r.code === 'in-flight') return res.status(409).json({ error: r.hint, code: r.code });
    res.json(r);
  } catch (e) { sendError(res, e); }
});

export default router;

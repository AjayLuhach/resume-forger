// Peer job sources — the local config file.
//
// A "peer" is another person's MongoDB whose already-scraped-and-analysed
// job_tracker rows this server pulls into its own database as pending rows
// (see peer-sync.js). Their connection string is a secret and it is THEIRS,
// so it never goes anywhere near Mongo, the mirror snapshots or the logs:
// it lives in data/peers.json (gitignored with the rest of data/), written
// mode 0600, and every value that leaves this module for an HTTP response or
// a log line goes through redactUri().
//
// File shape:
//   { peers: [ { id, label, uri, db, collection, enabled, windowDays,
//                includePeerRejected, addedAt, state: { ... } } ] }
//
// `state` is the sync loop's scratch space (cursor, counters, last error)
// and is persisted alongside the peer so a restart resumes where it left
// off instead of re-reading the peer's whole window.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import ConnectionString from 'mongodb-connection-string-url';
import { dbIdentity } from '../db.js';
import { log } from '../log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PEERS_FILE = path.join(__dirname, '..', '..', 'data', 'peers.json');
// Resolved on every call, not at import, so a test can point PEERS_FILE at
// a temp directory after this module has loaded.
export const peersFile = () => process.env.PEERS_FILE || DEFAULT_PEERS_FILE;

export const DEFAULT_WINDOW_DAYS = 30;
export const DEFAULT_COLLECTION = 'job_tracker';

// Query options a peer URI may carry. Anything else is refused outright:
// the driver accepts dozens of options and several of them (tlsCAFile,
// tlsCertificateKeyFile, proxyHost, ...) turn a connection string into a
// way to make this process read local files or talk to arbitrary hosts.
const ALLOWED_URI_OPTIONS = new Set([
  'authsource', 'retrywrites', 'w', 'appname', 'tls', 'ssl', 'replicaset',
  'readpreference', 'directconnection', 'serverselectiontimeoutms',
]);
const URI_OPTIONS_MESSAGE =
  'Connection string has an option that is not allowed — keep only authSource, retryWrites, w, appName, tls, ssl, replicaSet, readPreference, directConnection and serverSelectionTimeoutMS';

export class PeerConfigError extends Error {
  constructor(message, { code = 'bad-input', status = 400 } = {}) {
    super(message);
    this.name = 'PeerConfigError';
    this.code = code;
    this.status = status;
  }
}

// ── URI handling ───────────────────────────────────────────────────────────

// The credentials replaced by `_credentials_`, which is also the marker the
// PUT route uses to recognise "the redacted value came back unchanged".
export const redactUri = (uri) => {
  try {
    return new ConnectionString(String(uri)).redact().href;
  } catch {
    return '(invalid connection string)';
  }
};

// Strip anything that looks like a connection string from an error message
// before it is logged or returned. The driver embeds the URI in some parse
// errors, and a URI carries the password.
export const scrubMessage = (msg) =>
  String(msg || '')
    .replace(/mongodb(?:\+srv)?:\/\/\S+/gi, '[connection string]')
    .slice(0, 300);

const normalizeHost = (h) =>
  String(h || '')
    .trim()
    .toLowerCase()
    // 27017 is the default port, so host:27017 and host are the same server.
    .replace(/:27017$/, '');

// Identity of a database for the self-import and duplicate checks: sorted
// lowercase hosts + '/' + db. Two connection strings with different users,
// options or host order still map to the same key.
export const normalizePeerKey = (uri, db) => {
  const cs = new ConnectionString(String(uri));
  const hosts = cs.hosts.map(normalizeHost).filter(Boolean).sort();
  return `${hosts.join(',')}/${String(db || '').trim()}`;
};

// The key of THIS process's database. dbIdentity() only knows the host it
// could parse with the URL class, which rejects multi-host URIs — so the
// hosts come from the driver's own parser when MONGO_URI is available and
// fall back to dbIdentity() otherwise. The db name always comes from
// dbIdentity(), the same source every other module uses.
export const localPeerKey = () => {
  const { host, db } = dbIdentity();
  try {
    if (process.env.MONGO_URI) return normalizePeerKey(process.env.MONGO_URI, db);
  } catch { /* fall through to the URL-derived host */ }
  return `${host.split(',').map(normalizeHost).filter(Boolean).sort().join(',')}/${db}`;
};

// Parse + policy-check a connection string. Returns the ConnectionString on
// success; throws a PeerConfigError whose message never contains the input.
export const validateUri = (uri) => {
  const raw = typeof uri === 'string' ? uri.trim() : '';
  if (!raw) throw new PeerConfigError('Connection string is required', { code: 'bad-uri' });
  let cs;
  try {
    cs = new ConnectionString(raw);
  } catch {
    throw new PeerConfigError(
      'Connection string must start with mongodb:// or mongodb+srv:// and name at least one host',
      { code: 'bad-uri' },
    );
  }
  if (cs.protocol !== 'mongodb:' && cs.protocol !== 'mongodb+srv:') {
    throw new PeerConfigError('Connection string must use the mongodb:// or mongodb+srv:// scheme', { code: 'bad-uri' });
  }
  if (!cs.hosts.length) throw new PeerConfigError('Connection string names no host', { code: 'bad-uri' });
  for (const key of cs.searchParams.keys()) {
    if (!ALLOWED_URI_OPTIONS.has(key.toLowerCase())) {
      throw new PeerConfigError(URI_OPTIONS_MESSAGE, { code: 'bad-uri' });
    }
  }
  return cs;
};

const DB_NAME_RE = /^[^/\\. "$*<>:|?\0]{1,63}$/;
const COLLECTION_RE = /^(?!system\.)[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/;

// Normalise + validate the user-supplied fields of a peer. `db` falls back
// to the database named in the URI path. Duplicate/self checks are separate
// (see checkPeerKey) so a "test before add" can validate without them.
export const validatePeerInput = (input = {}) => {
  const label = typeof input.label === 'string' ? input.label.trim().replace(/\s+/g, ' ') : '';
  if (!label) throw new PeerConfigError('Label is required');
  if (label.length > 60) throw new PeerConfigError('Label must be 60 characters or fewer');

  const cs = validateUri(input.uri);
  const uri = String(input.uri).trim();

  const pathDb = cs.pathname.replace(/^\/+/, '');
  const db = (typeof input.db === 'string' && input.db.trim()) || pathDb;
  if (!db) throw new PeerConfigError('Database name is required (it is not in the connection string)');
  if (!DB_NAME_RE.test(db)) throw new PeerConfigError('Database name contains characters MongoDB does not allow');

  const collection = (typeof input.collection === 'string' && input.collection.trim()) || DEFAULT_COLLECTION;
  if (!COLLECTION_RE.test(collection)) throw new PeerConfigError('Collection name is not valid');

  let windowDays = DEFAULT_WINDOW_DAYS;
  if (input.windowDays !== undefined && input.windowDays !== null && input.windowDays !== '') {
    windowDays = Number(input.windowDays);
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) {
      throw new PeerConfigError('Window must be a whole number of days between 1 and 365');
    }
  }

  const includePeerRejected = input.includePeerRejected === true || input.includePeerRejected === 'true';

  return { label, uri, db, collection, windowDays, includePeerRejected, key: normalizePeerKey(uri, db) };
};

// Refuse our own database and any peer already configured with the same
// hosts + db. `ignoreId` lets an update skip the peer being edited.
export const checkPeerKey = (key, { peers = [], ignoreId = null } = {}) => {
  if (key === localPeerKey()) {
    throw new PeerConfigError('That is this server\'s own database — a peer must be someone else\'s', { code: 'self' });
  }
  const dup = peers.find((p) => p.id !== ignoreId && peerKeyOf(p) === key);
  if (dup) {
    throw new PeerConfigError(`Already configured as "${dup.label}"`, { code: 'duplicate', status: 409 });
  }
};

const peerKeyOf = (p) => {
  try { return normalizePeerKey(p.uri, p.db); } catch { return `?/${p.db}`; }
};

// ── State ──────────────────────────────────────────────────────────────────

export const freshState = () => ({
  cursor: { t: null, id: null },
  lastSyncAt: null,
  lastError: null,
  lastErrorAt: null,
  syncing: false,
  nextSyncAt: null,
  imported: 0,
  updated: 0,
  skipped: 0,
  skippedReasons: {},
  remoteAnalyzedCount: null,
});

// Tolerate a hand-edited or older file: every state field gets a default.
const normalizeState = (s = {}) => {
  const base = freshState();
  const out = { ...base, ...(s && typeof s === 'object' ? s : {}) };
  out.cursor = {
    t: typeof out.cursor?.t === 'string' ? out.cursor.t : null,
    id: out.cursor?.id != null ? String(out.cursor.id) : null,
  };
  for (const k of ['imported', 'updated', 'skipped']) out[k] = Number.isFinite(out[k]) ? out[k] : 0;
  out.skippedReasons = out.skippedReasons && typeof out.skippedReasons === 'object' ? out.skippedReasons : {};
  out.syncing = !!out.syncing;
  return out;
};

const normalizePeer = (p) => {
  if (!p || typeof p !== 'object' || typeof p.uri !== 'string') return null;
  return {
    id: typeof p.id === 'string' && p.id ? p.id : crypto.randomUUID(),
    label: typeof p.label === 'string' && p.label.trim() ? p.label.trim() : 'peer',
    uri: p.uri,
    db: typeof p.db === 'string' ? p.db : '',
    collection: typeof p.collection === 'string' && p.collection ? p.collection : DEFAULT_COLLECTION,
    enabled: p.enabled !== false,
    windowDays: Number.isInteger(p.windowDays) && p.windowDays > 0 ? p.windowDays : DEFAULT_WINDOW_DAYS,
    includePeerRejected: p.includePeerRejected === true,
    addedAt: typeof p.addedAt === 'string' ? p.addedAt : null,
    state: normalizeState(p.state),
  };
};

// ── File I/O ───────────────────────────────────────────────────────────────
// Synchronous on purpose: the file is a few KB, and sync read-modify-write
// means the sync loop and an HTTP handler can never interleave halfway
// through an update (single process, no awaits inside the critical section).

let _brokenFile = null;   // path of a file that failed to parse, until it is moved aside
let _warnedBroken = false;

export const readPeers = () => {
  const file = peersFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { peers: [] };
    log.warn('peers', `cannot read ${file}: ${e.message} — treating as empty`);
    return { peers: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.peers) ? parsed.peers : null;
    if (!list) throw new Error('expected { peers: [...] }');
    _brokenFile = null;
    return { peers: list.map(normalizePeer).filter(Boolean) };
  } catch (e) {
    // Never overwrite a file we could not parse — it may hold connection
    // strings the operator has nowhere else. It is moved aside on the next
    // write instead (see writePeers).
    _brokenFile = file;
    if (!_warnedBroken) {
      _warnedBroken = true;
      // Only the position, never the parser's message: JSON.parse quotes the
      // source around the failure, and in this file that is a connection
      // string with its password.
      const pos = /at position (\d+)/.exec(e.message)?.[1];
      log.warn('peers', `${file} is not valid JSON${pos ? ` (at position ${pos})` : ''} — using an empty peer list; fix or delete the file. It will be moved aside if a peer is added.`);
    }
    return { peers: [] };
  }
};

const chmodQuiet = (p) => {
  try { fs.chmodSync(p, 0o600); } catch (e) { if (e.code !== 'EPERM' && e.code !== 'ENOTSUP') throw e; }
};

export const writePeers = (cfg) => {
  const file = peersFile();
  const peers = Array.isArray(cfg?.peers) ? cfg.peers : [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (_brokenFile === file && fs.existsSync(file)) {
    const aside = `${file}.broken-${Date.now()}`;
    fs.renameSync(file, aside);
    log.warn('peers', `moved unparseable ${file} to ${aside}`);
    _brokenFile = null;
  }
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify({ peers }, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  chmodQuiet(file);
  return { peers };
};

// ── CRUD ───────────────────────────────────────────────────────────────────

export const getPeer = (id) => readPeers().peers.find((p) => p.id === id) || null;

export const addPeer = (input) => {
  const v = validatePeerInput(input);
  const cfg = readPeers();
  checkPeerKey(v.key, { peers: cfg.peers });
  const peer = {
    id: crypto.randomUUID(),
    label: v.label,
    uri: v.uri,
    db: v.db,
    collection: v.collection,
    enabled: true,
    windowDays: v.windowDays,
    includePeerRejected: v.includePeerRejected,
    addedAt: new Date().toISOString(),
    state: freshState(),
  };
  cfg.peers.push(peer);
  writePeers(cfg);
  log.ok('peers', `added "${peer.label}" (${redactUri(peer.uri)} db=${peer.db})`);
  return peer;
};

// A redacted uri echoed back from the form, or nothing at all, means "keep
// the stored one". A genuinely new uri re-validates; the cursor only resets
// when the peer's identity (hosts + db) actually changed, so re-typing the
// same cluster with a rotated password does not re-import 30 days of rows.
//
// The cursor also resets when the filter WIDENS — a longer window or opting
// in to the peer's rejected rows — because the rows the old filter excluded
// sit below the persisted cursor and would otherwise never be read. Rows
// already imported are skipped as "exists locally", so the re-read costs
// only peer reads.
export const updatePeer = (id, patch = {}) => {
  const cfg = readPeers();
  const peer = cfg.peers.find((p) => p.id === id);
  if (!peer) return null;

  const uriGiven = typeof patch.uri === 'string' && patch.uri.trim() && !patch.uri.includes('_credentials_');
  const next = validatePeerInput({
    label: patch.label !== undefined ? patch.label : peer.label,
    uri: uriGiven ? patch.uri : peer.uri,
    db: patch.db !== undefined ? patch.db : peer.db,
    collection: patch.collection !== undefined ? patch.collection : peer.collection,
    windowDays: patch.windowDays !== undefined ? patch.windowDays : peer.windowDays,
    includePeerRejected: patch.includePeerRejected !== undefined ? patch.includePeerRejected : peer.includePeerRejected,
  });
  const keyChanged = next.key !== peerKeyOf(peer);
  if (keyChanged) checkPeerKey(next.key, { peers: cfg.peers, ignoreId: id });

  const changed = {
    uri: uriGiven && next.uri !== peer.uri,
    db: next.db !== peer.db,
    collection: next.collection !== peer.collection,
    enabled: typeof patch.enabled === 'boolean' && patch.enabled !== peer.enabled,
    key: keyChanged,
    widened: next.windowDays > peer.windowDays || (next.includePeerRejected && !peer.includePeerRejected),
  };

  peer.label = next.label;
  peer.uri = next.uri;
  peer.db = next.db;
  peer.collection = next.collection;
  peer.windowDays = next.windowDays;
  peer.includePeerRejected = next.includePeerRejected;
  if (typeof patch.enabled === 'boolean') peer.enabled = patch.enabled;
  if (keyChanged || changed.collection || changed.widened) {
    peer.state.cursor = { t: null, id: null };
    peer.state.remoteAnalyzedCount = null;
  }
  if (changed.enabled && peer.enabled) {
    peer.state.lastError = null;
    peer.state.lastErrorAt = null;
  }
  writePeers(cfg);
  return { peer, changed };
};

export const removePeer = (id) => {
  const cfg = readPeers();
  const idx = cfg.peers.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const [peer] = cfg.peers.splice(idx, 1);
  writePeers(cfg);
  log.ok('peers', `removed "${peer.label}"`);
  return peer;
};

// Merge a partial state into one peer and persist. Used by the sync loop
// after every batch; counters passed as `add` accumulate instead of replace.
export const patchPeerState = (id, patch = {}, { add = {}, addReasons = {} } = {}) => {
  const cfg = readPeers();
  const peer = cfg.peers.find((p) => p.id === id);
  if (!peer) return null;
  Object.assign(peer.state, patch);
  for (const [k, n] of Object.entries(add)) {
    if (Number.isFinite(n) && n) peer.state[k] = (peer.state[k] || 0) + n;
  }
  for (const [reason, n] of Object.entries(addReasons)) {
    if (Number.isFinite(n) && n) peer.state.skippedReasons[reason] = (peer.state.skippedReasons[reason] || 0) + n;
  }
  writePeers(cfg);
  return peer;
};

export const setPeerEnabled = (id, enabled) => {
  const cfg = readPeers();
  const peer = cfg.peers.find((p) => p.id === id);
  if (!peer) return null;
  peer.enabled = !!enabled;
  writePeers(cfg);
  return peer;
};

// ── Views ──────────────────────────────────────────────────────────────────

const hostsOf = (uri) => {
  try { return new ConnectionString(uri).hosts.map((h) => h.toLowerCase()); } catch { return []; }
};

// What an HTTP response may carry: everything except the uri itself.
export const publicPeer = (p) => ({
  id: p.id,
  label: p.label,
  uriRedacted: redactUri(p.uri),
  hosts: hostsOf(p.uri),
  db: p.db,
  collection: p.collection,
  enabled: p.enabled,
  windowDays: p.windowDays,
  includePeerRejected: p.includePeerRejected,
  addedAt: p.addedAt,
  state: { ...p.state, cursor: { ...p.state.cursor } },
});

export const localIdentity = () => {
  const { host, db } = dbIdentity();
  return { host, db };
};

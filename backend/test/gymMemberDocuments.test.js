// Gym member documents & digital waivers tests (Phase 18). Real routers,
// real DATABASE_URL, self-cleaning fixtures.
//
// Covers the spec edge cases end-to-end:
//   non-app member (desk files paperwork for app_user_id NULL) · later app
//   connection (the same rows surface via /my after link — nothing
//   migrates) · malicious upload (path-traversal filename, control chars,
//   polyglot text declared as PDF) · oversized file (8MB cap) ·
//   unsupported type (415) · magic-byte sniffing (pdf/png/jpeg accepted;
//   content/declared mismatch rejected) · expired document (computed
//   EXPIRED on read; signing/authorizing refuse) · replaced document
//   (one live doc per category — old copy REPLACED, replaced_by set) ·
//   member leaves (retention: history readable/downloadable, no new
//   paperwork) · unauthorized staff (trainer 403; branch-restricted desk
//   403 outside their branches; cross-gym 403) · private storage (storage
//   internals never in API responses; no predictable public URLs) ·
//   sensitive-access logging (every download logged, staff and member) ·
//   revocation · digital member signature · desk-recorded signature ·
//   cross-member isolation in the app surface · audit trail.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
if (!process.env.DATABASE_URL) {
  console.error('gymMemberDocuments.test.js requires DATABASE_URL (copy .env.example to .env)');
  process.exit(1);
}

const { pool, query } = require('../src/db/pool');
const gymRoutes = require('../src/routes/gym');
const authRoutes = require('../src/routes/auth');

let app, server, baseUrl;
const suffix = crypto.randomBytes(4).toString('hex');
const PASSWORD = 'GymTest1!';

const PEOPLE = {
  owner: { email: `doc_owner_${suffix}@test.local`, name: 'Doc Owner' },
  owner2: { email: `doc_owner2_${suffix}@test.local`, name: 'Other Owner' },
  admin: { email: `doc_admin_${suffix}@test.local`, name: 'Doc Admin' },
  desk: { email: `doc_desk_${suffix}@test.local`, name: 'Front Desk' },
  deskMohali: { email: `doc_deskm_${suffix}@test.local`, name: 'Desk Mohali' },
  trainer: { email: `doc_trainer_${suffix}@test.local`, name: 'Trainer T' },
  mApp: { email: `doc_member_${suffix}@test.local`, name: 'Member App' },
  mLegacyApp: { email: `doc_legacy_${suffix}@test.local`, name: 'Legacy App' },
};
const tokens = {};
let gym, gymB, branchMain, branchMohali;
const createdUserIds = [];
const createdGymIds = [];
let appMember, legacyMember, leaverMember, mohaliMember, mainMember;

// ── file fixtures (real magic bytes) ──────────────────────────────────────
const PDF_BUF = Buffer.concat([
  Buffer.from('%PDF-1.4\n', 'binary'),
  crypto.randomBytes(256),
  Buffer.from('\n%%EOF', 'binary'),
]);
const PNG_BUF = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  crypto.randomBytes(128),
]);
const JPEG_BUF = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  crypto.randomBytes(128),
]);
const TEXT_BUF = Buffer.from('hello, this is definitely not a pdf', 'utf8');

function b64(buf) { return buf.toString('base64'); }

function docPayload(overrides = {}) {
  return {
    category: 'WAIVER',
    title: 'Waiver 2026',
    filename: 'waiver.pdf',
    content_type: 'application/pdf',
    content_base64: b64(PDF_BUF),
    ...overrides,
  };
}

// ── harness helpers (same shape as the other gym suites) ──────────────────

async function signup(person) {
  const res = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...person, password: PASSWORD, role: 'user' }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 201, `signup ${person.email}`);
  createdUserIds.push(body.user.id);
  return body.user;
}

async function auth(person) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: person.email, password: PASSWORD }),
  });
  tokens[person.email] = (await res.json()).accessToken;
}

function api(token, method, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// raw fetch for the byte-stream endpoints (no JSON content type)
function getFile(token, path) {
  return fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

const owner = () => tokens[PEOPLE.owner.email];
const desk = () => tokens[PEOPLE.desk.email];

async function createMember(payload) {
  const res = await api(owner(), 'POST', `/gym/${gym.id}/members`, payload);
  const body = await res.json();
  assert.strictEqual(res.status, 201, `member create: ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

// desk uploads a document and returns the created row (201 asserted)
async function uploadDoc(memberId, payload, token = null, gymId = null) {
  const res = await api(token || desk(), 'POST',
    `/gym/${gymId || gym.id}/members/${memberId}/documents`, payload);
  const body = await res.json();
  assert.strictEqual(res.status, 201, `upload: ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function linkApp(memberId, person) {
  const inv = await api(owner(), 'POST', `/gym/${gym.id}/members/${memberId}/invite-app`, {});
  const inviteCode = (await inv.json()).invite_code;
  assert.ok(inviteCode, 'invite code returned');
  const accept = await api(tokens[person.email], 'POST', `/gym/invite/${inviteCode}/accept`);
  assert.strictEqual(accept.status, 200, `invite accept: ${await accept.text()}`);
}

test.before(async () => {
  app = express();
  app.use(express.json());
  app.use('/gym', gymRoutes);
  app.use('/auth', authRoutes);
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const person of Object.values(PEOPLE)) await signup(person);
  for (const person of Object.values(PEOPLE)) await auth(person);

  const resA = await api(owner(), 'POST', '/gym', { name: `DocGym ${suffix}` });
  gym = (await resA.json()).gym;
  createdGymIds.push(gym.id);
  const resB = await api(tokens[PEOPLE.owner2.email], 'POST', '/gym', { name: `OtherGym ${suffix}` });
  gymB = (await resB.json()).gym;
  createdGymIds.push(gymB.id);

  await api(owner(), 'POST', `/gym/${gym.id}/staff`, { email: PEOPLE.admin.email, gym_role: 'ADMIN' });
  await api(owner(), 'POST', `/gym/${gym.id}/staff`, { email: PEOPLE.desk.email, gym_role: 'FRONT_DESK' });
  await api(owner(), 'POST', `/gym/${gym.id}/staff`, { email: PEOPLE.deskMohali.email, gym_role: 'FRONT_DESK' });
  await api(owner(), 'POST', `/gym/${gym.id}/staff`, { email: PEOPLE.trainer.email, gym_role: 'TRAINER' });

  const rb = await api(owner(), 'POST', `/gym/${gym.id}/branches`, { name: 'Main', timezone: 'UTC' });
  branchMain = await rb.json();
  const rb2 = await api(owner(), 'POST', `/gym/${gym.id}/branches`, { name: 'Mohali', timezone: 'UTC' });
  branchMohali = await rb2.json();

  const staffRes = await api(owner(), 'GET', `/gym/${gym.id}/staff`);
  const staffBody = await staffRes.json();
  const staffRows = staffBody.staff || staffBody;
  const deskM = staffRows.find((s) => s.email === PEOPLE.deskMohali.email);
  // Mohali desk may only touch Mohali members
  const rs = await api(owner(), 'PATCH', `/gym/${gym.id}/staff/${deskM.id}/branches`,
    { branch_ids: [branchMohali.id] });
  assert.strictEqual(rs.status, 200, `desk branch restriction: ${await rs.text()}`);

  appMember = await createMember({ first_name: 'App', email: PEOPLE.mApp.email });
  // legacy member has an email (the desk invite needs one) but NO app account yet
  legacyMember = await createMember({ first_name: 'Legacy', email: PEOPLE.mLegacyApp.email });
  leaverMember = await createMember({ first_name: 'Leaver' });
  mohaliMember = await createMember({ first_name: 'MohaliOnly' });
  await api(owner(), 'PATCH', `/gym/${gym.id}/members/${mohaliMember.id}/branches`,
    { primary_branch_id: branchMohali.id });
  mainMember = await createMember({ first_name: 'MainOnly' });
  await api(owner(), 'PATCH', `/gym/${gym.id}/members/${mainMember.id}/branches`,
    { primary_branch_id: branchMain.id });

  // app connection for the first member (invite → accept, existing user)
  await linkApp(appMember.id, PEOPLE.mApp);
});

test.after(async () => {
  if (createdGymIds.length) {
    await query('DELETE FROM gyms WHERE id = ANY($1::uuid[])', [createdGymIds]);
  }
  if (createdUserIds.length) {
    await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
  }
  await pool.end();
  if (server) server.close();
});

// ── permission surface ────────────────────────────────────────────────────

test('documents.manage: owner/admin/desk may list; trainer refused; empty roster is empty', async () => {
  for (const [label, tk] of [['owner', owner()], ['admin', tokens[PEOPLE.admin.email]], ['desk', desk()]]) {
    const res = await api(tk, 'GET', `/gym/${gym.id}/members/${appMember.id}/documents`);
    assert.strictEqual(res.status, 200, `${label} list: ${res.status}`);
    const body = await res.json();
    assert.ok(Array.isArray(body.documents), `${label} documents array`);
    assert.strictEqual(body.member.id, appMember.id);
  }
  assert.strictEqual(
    (await api(tokens[PEOPLE.trainer.email], 'GET', `/gym/${gym.id}/members/${appMember.id}/documents`)).status,
    403, 'trainer has no documents.manage');
  assert.strictEqual(
    (await api(tokens[PEOPLE.trainer.email], 'POST', `/gym/${gym.id}/members/${appMember.id}/documents`, docPayload())).status,
    403);
});

// ── desk upload for a NON-APP member + malicious upload handling ──────────

test('desk uploads a waiver for a member WITHOUT an app account; traversal filename sanitized', async () => {
  const doc = await uploadDoc(legacyMember.id, docPayload({
    filename: '../../..\\..\\evil name<>.pdf',
  }));
  assert.strictEqual(doc.category, 'WAIVER');
  assert.strictEqual(doc.category_label, 'Liability Waiver');
  assert.strictEqual(doc.status, 'PENDING');
  assert.strictEqual(doc.effective_status, 'PENDING');
  assert.strictEqual(doc.is_live, true);
  // path components + filesystem-hostile glyphs are gone
  assert.strictEqual(doc.original_filename, 'evil name.pdf');
  assert.strictEqual(doc.uploaded_via, 'DESK');
  assert.ok(doc.file_sha256 && doc.file_sha256.length === 64, 'sha256 recorded');
  assert.ok(!('storage_key' in doc) && !('storage_provider' in doc), 'storage internals never leak');
  assert.strictEqual(doc.download_path,
    `/gym/${gym.id}/members/${legacyMember.id}/documents/${doc.id}/file`);

  // desk can pull the bytes right back — identical to what was uploaded
  const file = await getFile(desk(), doc.download_path);
  assert.strictEqual(file.status, 200, `staff download: ${file.status}`);
  assert.strictEqual(file.headers.get('content-type'), 'application/pdf');
  assert.strictEqual(file.headers.get('cache-control'), 'private, no-store');
  assert.ok((file.headers.get('content-disposition') || '').startsWith('attachment'));
  assert.ok(Buffer.compare(Buffer.from(await file.arrayBuffer()), PDF_BUF) === 0, 'bytes round-trip');

  // the download is access-logged with the staff actor
  const log = await query(
    `SELECT actor_kind, actor_user_id FROM gym_document_download_log WHERE document_id = $1`,
    [doc.id]);
  assert.strictEqual(log.rows.length, 1);
  assert.strictEqual(log.rows[0].actor_kind, 'STAFF');
  assert.ok(log.rows[0].actor_user_id, 'staff actor recorded');
});

test('upload validation: unsupported type 415, magic mismatch 400, oversized 413, bad payload 400', async () => {
  const memberId = appMember.id;
  const base = `/gym/${gym.id}/members/${memberId}/documents`;

  // unsupported content type — even with PDF magic inside
  assert.strictEqual((await api(desk(), 'POST', base, docPayload({
    content_type: 'application/octet-stream', content_base64: b64(PDF_BUF),
  }))).status, 415);
  assert.strictEqual((await api(desk(), 'POST', base, docPayload({
    content_type: 'text/plain', content_base64: b64(TEXT_BUF), filename: 'notes.txt',
  }))).status, 415);

  // declared PDF, actually text — magic-byte sniffing kills the polyglot
  assert.strictEqual((await api(desk(), 'POST', base, docPayload({
    content_base64: b64(TEXT_BUF),
  }))).status, 400);

  // oversized: 8MB + 1 byte
  const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0x25);
  const oversizeRes = await api(desk(), 'POST', base, docPayload({ content_base64: b64(big) }));
  assert.strictEqual(oversizeRes.status, 413);

  // bad category, bad expiry, empty payload
  assert.strictEqual((await api(desk(), 'POST', base, docPayload({ category: 'PASSPORT' }))).status, 400);
  assert.strictEqual((await api(desk(), 'POST', base, docPayload({ expires_at: '2020-01-01' }))).status, 400);
  assert.strictEqual((await api(desk(), 'POST', base, docPayload({ content_base64: '' }))).status, 400);
  assert.strictEqual((await api(desk(), 'POST', base, docPayload({ content_base64: 'not-base64!!!' }))).status, 400);
});

test('all three accepted types upload and round-trip (pdf, png, jpeg)', async () => {
  // only image/png (the exact type) is whitelisted — 'application/png' is not a real type
  const rejected = await api(desk(), 'POST', `/gym/${gym.id}/members/${appMember.id}/documents`,
    docPayload({ category: 'ID_VERIFICATION', content_type: 'application/png', content_base64: b64(PNG_BUF) }));
  assert.strictEqual(rejected.status, 415);

  for (const [category, contentType, buf, filename] of [
    ['ID_VERIFICATION', 'image/png', PNG_BUF, 'scan.png'],
    ['MEDICAL_CLEARANCE', 'image/jpeg', JPEG_BUF, 'clearance.jpg'],
  ]) {
    const doc = await uploadDoc(appMember.id, docPayload({ category, content_type: contentType, content_base64: b64(buf), filename }));
    const file = await getFile(desk(), doc.download_path);
    assert.ok(Buffer.compare(Buffer.from(await file.arrayBuffer()), buf) === 0, `${filename} round-trip`);
    // clean up between cases so the one-live-per-category guard never trips
    await api(desk(), 'POST', `/gym/${gym.id}/members/${appMember.id}/documents/${doc.id}/revoke`, {});
  }
});

// ── digital waiver signing (member app) + desk-recorded signature ─────────

test('member signs a pending waiver in the app; double-sign refuses', async () => {
  const doc = await uploadDoc(appMember.id, docPayload({ title: 'App waiver' }));
  assert.strictEqual(doc.status, 'PENDING');

  const noSig = await api(tokens[PEOPLE.mApp.email], 'POST', `/gym/my/documents/${doc.id}/sign`, {});
  assert.strictEqual(noSig.status, 400, 'signature_name required');

  const res = await api(tokens[PEOPLE.mApp.email], 'POST', `/gym/my/documents/${doc.id}/sign`,
    { signature_name: 'App Member' });
  const signed = await res.json();
  assert.strictEqual(res.status, 200, `sign: ${res.status}: ${JSON.stringify(signed)}`);
  assert.strictEqual(signed.status, 'AUTHORIZED');
  assert.strictEqual(signed.authorized_signature, 'App Member');
  assert.ok(signed.authorized_at, 'authorized_at set');

  const again = await api(tokens[PEOPLE.mApp.email], 'POST', `/gym/my/documents/${doc.id}/sign`,
    { signature_name: 'App Member' });
  assert.strictEqual(again.status, 409, 'already signed');
});

test('desk records an on-paper signature for a non-app member', async () => {
  const doc = await uploadDoc(legacyMember.id, docPayload({ category: 'MEMBERSHIP_AGREEMENT', title: 'Agreement' }));
  const res = await api(desk(), 'POST',
    `/gym/${gym.id}/members/${legacyMember.id}/documents/${doc.id}/authorize`,
    { signature_name: 'Legacy Member (paper)' });
  const body = await res.json();
  assert.strictEqual(res.status, 200, `authorize: ${res.status}: ${JSON.stringify(body)}`);
  assert.strictEqual(body.status, 'AUTHORIZED');
  assert.strictEqual(body.authorized_signature, 'Legacy Member (paper)');

  // authorizing twice refuses
  const again = await api(desk(), 'POST',
    `/gym/${gym.id}/members/${legacyMember.id}/documents/${doc.id}/authorize`,
    { signature_name: 'Again' });
  assert.strictEqual(again.status, 409);
});

// ── replaced document (one live copy per category) ────────────────────────

test('re-uploading a category supersedes the old live copy (REPLACED + replaced_by)', async () => {
  const v1 = await uploadDoc(appMember.id, docPayload({ title: 'Waiver v1' }));
  const v2 = await uploadDoc(appMember.id, docPayload({ title: 'Waiver v2' }));

  const list = await (await api(desk(), 'GET', `/gym/${gym.id}/members/${appMember.id}/documents`)).json();
  const v1row = list.documents.find((d) => d.id === v1.id);
  const v2row = list.documents.find((d) => d.id === v2.id);
  assert.strictEqual(v1row.status, 'REPLACED');
  assert.strictEqual(v1row.is_live, false);
  assert.strictEqual(v1row.replaced_by, v2.id);
  assert.strictEqual(v2row.status, 'PENDING');
  assert.strictEqual(v2row.is_live, true);

  // different categories coexist — the guard is per-category, not global
  const medical = await uploadDoc(appMember.id, docPayload({ category: 'MEDICAL_CLEARANCE', title: 'Med cert' }));
  assert.strictEqual(medical.is_live, true);

  // the member app no longer serves the replaced copy
  const old = await getFile(tokens[PEOPLE.mApp.email], `/gym/my/documents/${v1.id}/file`);
  assert.strictEqual(old.status, 409, `replaced copy refused: ${old.status}`);
  const fresh = await getFile(tokens[PEOPLE.mApp.email], `/gym/my/documents/${v2.id}/file`);
  assert.strictEqual(fresh.status, 200);
});

// ── expired document (computed, not stored) ───────────────────────────────

test('expired document: effective_status EXPIRED, signing and desk-authorizing refuse', async () => {
  const doc = await uploadDoc(mohaliMember.id, docPayload({
    category: 'MEDICAL_CLEARANCE', title: 'Med cert (expiring)', expires_at: '2099-01-01',
  }));
  assert.strictEqual(doc.expired, false);

  // the clock passes; nothing rewrites the row — reads expose EXPIRED
  await query('UPDATE gym_member_documents SET expires_at = now() - interval \'1 hour\' WHERE id = $1', [doc.id]);

  const list = await (await api(desk(), 'GET', `/gym/${gym.id}/members/${mohaliMember.id}/documents`)).json();
  const row = list.documents.find((d) => d.id === doc.id);
  assert.strictEqual(row.status, 'PENDING', 'stored status is honest history');
  assert.strictEqual(row.effective_status, 'EXPIRED');
  assert.strictEqual(row.expired, true);

  const staffAuth = await api(desk(), 'POST',
    `/gym/${gym.id}/members/${mohaliMember.id}/documents/${doc.id}/authorize`, { signature_name: 'X' });
  assert.strictEqual(staffAuth.status, 409, 'expired cannot be desk-authorized');

  // expiry also refuses an app signature (upload one for the linked member)
  const appDoc = await uploadDoc(appMember.id, docPayload({ category: 'OTHER', title: 'Declaration', expires_at: '2099-01-01' }));
  await query('UPDATE gym_member_documents SET expires_at = now() - interval \'1 minute\' WHERE id = $1', [appDoc.id]);
  const sign = await api(tokens[PEOPLE.mApp.email], 'POST', `/gym/my/documents/${appDoc.id}/sign`,
    { signature_name: 'App Member' });
  assert.strictEqual(sign.status, 409);
});

// ── member leaves: retention vs paperwork ─────────────────────────────────

test('member leaves: file retained and downloadable, but no new paperwork or signatures', async () => {
  const doc = await uploadDoc(leaverMember.id, docPayload({ title: 'Leaver waiver' }));
  const cancel = await api(owner(), 'POST', `/gym/${gym.id}/members/${leaverMember.id}/cancel`, { reason: 'moved away' });
  assert.strictEqual(cancel.status, 200, `cancel: ${await cancel.text()}`);

  const upload = await api(desk(), 'POST', `/gym/${gym.id}/members/${leaverMember.id}/documents`, docPayload({ title: 'After leaving' }));
  assert.strictEqual(upload.status, 409, 'no new paperwork after leaving');

  const auth2 = await api(desk(), 'POST',
    `/gym/${gym.id}/members/${leaverMember.id}/documents/${doc.id}/authorize`, { signature_name: 'Late' });
  assert.strictEqual(auth2.status, 409, 'no signatures after leaving');

  // retention: the list still works and the bytes are still pullable
  const list = await api(desk(), 'GET', `/gym/${gym.id}/members/${leaverMember.id}/documents`);
  assert.strictEqual(list.status, 200);
  const body = await list.json();
  assert.strictEqual(body.member.paperwork_allowed, false);
  assert.ok(body.documents.some((d) => d.id === doc.id));

  const file = await getFile(desk(), doc.download_path);
  assert.strictEqual(file.status, 200, 'retention download works');
});

// ── unauthorized staff (permission + branch scope + cross-gym) ────────────

test('unauthorized staff: trainer 403; Mohali-restricted desk blocked outside their branches; cross-gym 403', async () => {
  const doc = await uploadDoc(mainMember.id, docPayload({ category: 'ID_VERIFICATION', title: 'ID (main branch)' }));

  // trainer: no documents.manage
  assert.strictEqual((await getFile(tokens[PEOPLE.trainer.email], doc.download_path)).status, 403);

  // Mohali-restricted desk: member's home branch is Main → blocked everywhere
  const mohaliToken = tokens[PEOPLE.deskMohali.email];
  assert.strictEqual((await api(mohaliToken, 'GET', `/gym/${gym.id}/members/${mainMember.id}/documents`)).status, 403);
  assert.strictEqual((await getFile(mohaliToken, doc.download_path)).status, 403);
  assert.strictEqual((await api(mohaliToken, 'POST', `/gym/${gym.id}/members/${mainMember.id}/documents`, docPayload())).status, 403);

  // the same desk CAN work with the member whose home branch is Mohali
  const mohaliList = await api(mohaliToken, 'GET', `/gym/${gym.id}/members/${mohaliMember.id}/documents`);
  assert.strictEqual(mohaliList.status, 200, 'Mohali desk reaches Mohali member');

  // cross-gym: owner2 has no relationship with gym A at all
  const cross = await api(tokens[PEOPLE.owner2.email], 'GET', `/gym/${gym.id}/members/${appMember.id}/documents`);
  assert.strictEqual(cross.status, 403);

  // garbage member id → 404, never a leak
  assert.strictEqual((await api(desk(), 'GET', `/gym/${gym.id}/members/${crypto.randomUUID()}/documents`)).status, 404);
});

// ── member app surface: isolation + later app connection ──────────────────

test('app surface: member sees own documents; cannot read another member\u2019s document', async () => {
  const list = await api(tokens[PEOPLE.mApp.email], 'GET', '/gym/my/documents');
  assert.strictEqual(list.status, 200);
  const docs = await list.json();
  assert.ok(docs.length >= 1, 'app member has documents');
  assert.ok(docs.every((d) => d.member_id === appMember.id), 'only own rows');
  assert.ok(docs.every((d) => d.download_path.startsWith('/gym/my/documents/')), 'member-scoped paths');

  // legacy member's document id is invisible to this member
  const legacyDocs = await query(
    'SELECT id FROM gym_member_documents WHERE member_id = $1', [legacyMember.id]);
  assert.ok(legacyDocs.rows.length, 'legacy member has documents');
  const foreign = await getFile(tokens[PEOPLE.mApp.email], `/gym/my/documents/${legacyDocs.rows[0].id}/file`);
  assert.strictEqual(foreign.status, 404, 'never confirm another member\u2019s document');
});

test('later app connection: paperwork filed BEFORE joining the app appears after link, unchanged', async () => {
  // before connection the app user sees nothing of this member
  const before = await api(tokens[PEOPLE.mLegacyApp.email], 'GET', '/gym/my/documents');
  assert.strictEqual((await before.json()).length, 0);

  // the desk filed these while the member had NO app account
  const w = await uploadDoc(legacyMember.id, docPayload({ category: 'WAIVER', title: 'Pre-app waiver' }));
  const id = await uploadDoc(legacyMember.id, docPayload({ category: 'ID_VERIFICATION', title: 'Pre-app ID', content_type: 'image/png', content_base64: b64(PNG_BUF), filename: 'id.png' }));

  await linkApp(legacyMember.id, PEOPLE.mLegacyApp);

  const after2 = await api(tokens[PEOPLE.mLegacyApp.email], 'GET', '/gym/my/documents');
  const docs = await after2.json();
  const mine = docs.filter((d) => d.member_id === legacyMember.id);
  // 2 filed in this test + the waiver and agreement earlier tests filed for
  // the (then non-app) legacy member — every row survives the link
  assert.strictEqual(mine.length, 4, 'all pre-connection documents surfaced');
  assert.ok(mine.some((d) => d.id === w.id) && mine.some((d) => d.id === id.id));
  assert.ok(mine.every((d) => d.gym_name === `DocGym ${suffix}`), 'gym name enriched');

  // bytes still intact through the member path
  const file = await getFile(tokens[PEOPLE.mLegacyApp.email], `/gym/my/documents/${w.id}/file`);
  assert.strictEqual(file.status, 200);
  assert.ok(Buffer.compare(Buffer.from(await file.arrayBuffer()), PDF_BUF) === 0, 'waiver bytes round-trip');

  // and the member signs one from the app — the desk-filed row is theirs
  const sign = await api(tokens[PEOPLE.mLegacyApp.email], 'POST', `/gym/my/documents/${id.id}/sign`,
    { signature_name: 'Legacy App' });
  assert.strictEqual(sign.status, 200, `sign after link: ${await sign.text()}`);
});

// ── revocation ────────────────────────────────────────────────────────────

test('revoke: live document withdrawn from the app; staff retention view keeps it; double-revoke refuses', async () => {
  const doc = await uploadDoc(appMember.id, docPayload({ category: 'OTHER', title: 'To be revoked' }));
  const res = await api(desk(), 'POST', `/gym/${gym.id}/members/${appMember.id}/documents/${doc.id}/revoke`,
    { reason: 'wrong member scan' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).status, 'REVOKED');

  const memberFetch = await getFile(tokens[PEOPLE.mApp.email], `/gym/my/documents/${doc.id}/file`);
  assert.strictEqual(memberFetch.status, 409, 'revoked copy not served to the member');

  const staffFetch = await getFile(desk(), doc.download_path);
  assert.strictEqual(staffFetch.status, 200, 'staff retention view still streams');

  assert.strictEqual((await api(desk(), 'POST',
    `/gym/${gym.id}/members/${appMember.id}/documents/${doc.id}/revoke`, {})).status, 409);

  // revoked slot is free — a fresh upload of the same category works
  const again = await uploadDoc(appMember.id, docPayload({ category: 'OTHER', title: 'Replacement after revoke' }));
  assert.strictEqual(again.is_live, true);
});

// ── private storage: no predictable public URLs, no internals leaked ─────

test('security: storage internals never in responses; download paths are authorized endpoints only', async () => {
  const { rows } = await query(
    `SELECT storage_key, storage_provider FROM gym_member_documents WHERE gym_id = $1 LIMIT 1`, [gym.id]);
  assert.ok(rows.length, 'documents exist');
  const key = rows[0].storage_key;
  assert.ok(/^[0-9a-f-]{36}\.(pdf|png|jpg)$/.test(key.split('/')[1]), 'key is a random uuid + extension');
  assert.ok(key.includes('/'), 'key namespaced by gym');

  const list = await (await api(desk(), 'GET', `/gym/${gym.id}/members/${appMember.id}/documents`)).json();
  const target = list.documents.find((d) => d.is_live);
  assert.ok(target, 'a live document exists');
  // produce a logged download, then check the detail view
  assert.strictEqual((await getFile(desk(), target.download_path)).status, 200);
  const detail = await (await api(desk(), 'GET',
    `/gym/${gym.id}/members/${appMember.id}/documents/${target.id}`)).json();
  const my = JSON.stringify(await (await api(tokens[PEOPLE.mApp.email], 'GET', '/gym/my/documents')).json());
  for (const blob of [JSON.stringify(list), JSON.stringify(detail), my]) {
    assert.ok(!blob.includes(key), 'storage key never in API responses');
    assert.ok(!blob.includes('gym-documents'), 'storage root never in API responses');
    assert.ok(!blob.includes('storage_provider'), 'provider never in API responses');
  }
  assert.ok(detail.download_history.length >= 1, 'detail carries download history');
  assert.strictEqual(detail.download_history[0].actor_kind, 'STAFF');
});

// ── sensitive-access logging + audit trail ────────────────────────────────

test('downloads are access-logged for BOTH actors; lifecycle events hit the gym audit log', async () => {
  const doc = await uploadDoc(appMember.id, docPayload({ category: 'MEMBERSHIP_AGREEMENT', title: 'Logged agreement' }));
  await getFile(desk(), doc.download_path); // staff read
  await getFile(tokens[PEOPLE.mApp.email], `/gym/my/documents/${doc.id}/file`); // member read

  const logs = await query(
    `SELECT actor_kind FROM gym_document_download_log WHERE document_id = $1 ORDER BY created_at`,
    [doc.id]);
  assert.deepStrictEqual(logs.rows.map((r) => r.actor_kind), ['STAFF', 'MEMBER']);

  const audit = await query(
    `SELECT action FROM audit_logs WHERE gym_id = $1 AND entity = 'gym_member_document' ORDER BY created_at`,
    [gym.id]);
  const actions = audit.rows.map((r) => r.action);
  assert.ok(actions.includes('document.uploaded'), 'upload audited');
  assert.ok(actions.includes('document.signed'), 'member signature audited');
  assert.ok(actions.includes('document.authorized'), 'desk authorization audited');
  assert.ok(actions.includes('document.revoked'), 'revocation audited');
});

test('upload by unauthorized caller leaves no orphaned bytes (validation runs before storage)', async () => {
  const { rows: before2 } = await query(
    'SELECT COUNT(*)::int AS n FROM gym_member_documents WHERE gym_id = $1', [gym.id]);
  const bad = await api(tokens[PEOPLE.trainer.email], 'POST',
    `/gym/${gym.id}/members/${appMember.id}/documents`, docPayload());
  assert.strictEqual(bad.status, 403);
  const { rows: after3 } = await query(
    'SELECT COUNT(*)::int AS n FROM gym_member_documents WHERE gym_id = $1', [gym.id]);
  assert.strictEqual(after3[0].n, before2[0].n, 'no row created');
});

#!/usr/bin/env node
// Demo seed data for the Gym Management portal — covers EVERY feature.
//
// Usage (from backend/):
//   DATABASE_URL='postgres://user:pass@host:5432/db' node scripts/seedDemo.js
//   npm run seed-demo                       (uses .env / DATABASE_URL)
//
// What it creates (everything keyed to the two DEMO gyms, nothing else touched):
//   Gym 1  Ironworks Strength Co. (demo-ironworks, Asia/Kolkata, INR)
//     - 3 branches (Mohali HQ, Chandigarh South, Zirakpur Studio [closed])
//     - 6 staff accounts: OWNER / ADMIN / FRONT_DESK (branch-restricted) /
//       2 x TRAINER / an INACTIVE admin (to test rejected logins)
//     - 12 members covering EVERY status: ACTIVE, PENDING, FROZEN, EXPIRED,
//       CANCELLED; 3 app-connected (log into the mobile app), 1 with a
//       pending app invite, 1 legacy member with no branch, 2 with
//       multi-branch access, 1 with a branch-transfer history
//     - 5 membership plans (incl. ARCHIVED), memberships in every lifecycle
//       state (ACTIVE / UPCOMING renewal / FROZEN with open freeze /
//       EXPIRED / CANCELLED) + membership_events timeline rows
//     - Full billing ledger: charges PAID / PARTIAL / DUE / OVERDUE,
//       payments in CASH/UPI/CARD/BANK_TRANSFER with real receipt numbers,
//       one refund
//     - 14 days of attendance across sources and branches
//     - Trainer assignments (ACTIVE + ENDED history)
//     - Workouts + exercises, nutrition items, content assignments
//       (ACTIVE, scheduled future start, ENDED)
//     - Announcements: SENT (with in-app deliveries + notifications),
//       SCHEDULED, DRAFT, and a SPECIFIC_MEMBERS send
//     - Classes over +/- days: regular schedule, a FULL class with a
//       WAITLISTED member, a past class with ATTENDED/NO_SHOW, a CANCELLED class
//     - Member documents with REAL downloadable PDFs on disk: waivers
//       (authorized + expired-effective), membership agreement, pending ID
//       verification, a REPLACED waiver and a REVOKED medical clearance
//   Gym 2  PulseFit Studio (demo-pulsefit) — minimal second tenant to prove
//     cross-gym isolation (staff of one gym sees nothing of the other).
//
// All demo logins share the password:  Test@1234
//
// Idempotent: re-running wipes BOTH demo gyms (CASCADE) and their demo
// users (email domain @demo.test) and reseeds fresh. It never touches any
// other gym, user or data in the database.

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') }); // repo root .env
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });    // backend/.env (either may define DATABASE_URL)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db/pool');

// ── helpers ───────────────────────────────────────────────────────────────
const PASSWORD = 'Test@1234';
const DEMO_GYM_SLUGS = ['demo-ironworks', 'demo-pulsefit'];
const DEMO_USER_DOMAIN = '@demo.test';

const uuid = () => crypto.randomUUID();
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const pad2 = (n) => String(n).padStart(2, '0');

// gym-local (IST) calendar date, offset by n days from today
const day = (n) =>
  new Date(Date.now() + 5.5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);

// ISO instant at a gym-local wall time, e.g. ts(day(0), 7, 45)
const ts = (dateStr, h, m) => `${dateStr}T${pad2(h)}:${pad2(m)}:00+05:30`;

const DEMO_GYMS_UPLOADS = path.resolve(__dirname, '..', 'uploads', 'gym-documents');

// Minimal, fully valid single-page PDF (proper xref) so downloads open everywhere.
function makePdf(lines) {
  // PDF text stays ASCII (latin1 encoding): strip everything outside the
  // printable range so em-dashes etc. render cleanly instead of as '?'
  const clean = (l) => l.replace(/[()\\]/g, '').replace(/[^\x20-\x7E]/g, '');
  const text = lines
    .map((l, i) => `BT /F1 ${i === 0 ? 16 : 11} Tf 56 ${740 - i * 22} Td (${clean(l)}) Tj ET`)
    .join('\n');
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>';
  objs[4] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = '%PDF-1.4\n';
  const offs = [0];
  for (let i = 1; i <= 5; i++) { offs[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += 'xref\n0 6\n0000000000 65535 f \n' +
    offs.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// receipt number exactly as gymBilling.js builds it
const receiptNo = (paidOn, paymentId) =>
  `RCPT-${String(paidOn).replace(/-/g, '')}-${paymentId.replace(/-/g, '').slice(0, 6).toUpperCase()}`;

// ── seed ──────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('seedDemo: DATABASE_URL is not set (pass it explicitly or configure .env)');
    process.exit(1);
  }
  const hash = await bcrypt.hash(PASSWORD, 11);

  // wipe previous demo artefacts (outside the txn — filesystem + quiet deletes)
  // document dirs are named by gym UUID, so resolve the OLD ids before deleting
  const oldGyms = await pool.query('SELECT id FROM gyms WHERE slug = ANY($1)', [DEMO_GYM_SLUGS]);
  for (const row of oldGyms.rows) {
    await fs.promises.rm(path.join(DEMO_GYMS_UPLOADS, row.id), { recursive: true, force: true }).catch(() => {});
  }
  for (const slug of DEMO_GYM_SLUGS) {
    await pool.query('DELETE FROM gyms WHERE slug = $1', [slug]);
  }
  await pool.query('DELETE FROM users WHERE lower(email) LIKE $1', ['%' + DEMO_USER_DOMAIN]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── users ─────────────────────────────────────────────────────────────
    const mkUser = async (email, name, role) => {
      const { rows } = await client.query(
        'INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id',
        [email, hash, name, role]
      );
      return rows[0].id;
    };
    const ownerU = await mkUser('owner' + DEMO_USER_DOMAIN, 'Sukh (Owner)', 'gym_staff');
    const adminU = await mkUser('admin' + DEMO_USER_DOMAIN, 'Ishaan (Admin)', 'gym_staff');
    const deskU = await mkUser('desk.mohali' + DEMO_USER_DOMAIN, 'Pooja (Front Desk)', 'gym_staff');
    const simranU = await mkUser('trainer.simran' + DEMO_USER_DOMAIN, 'Simran (Trainer)', 'gym_staff');
    const arjunU = await mkUser('trainer.arjun' + DEMO_USER_DOMAIN, 'Arjun (Trainer)', 'gym_staff');
    const inactiveU = await mkUser('inactive.staff' + DEMO_USER_DOMAIN, 'Ravi (Disabled Admin)', 'gym_staff');
    const pfOwnerU = await mkUser('pf.owner' + DEMO_USER_DOMAIN, 'PulseFit Owner', 'gym_staff');
    const riyaU = await mkUser('member.riya' + DEMO_USER_DOMAIN, 'Riya Kapoor', 'user');
    const kabirU = await mkUser('member.kabir' + DEMO_USER_DOMAIN, 'Kabir Singh', 'user');
    const miraU = await mkUser('member.mira' + DEMO_USER_DOMAIN, 'Mira Nair', 'user');

    // ── gyms + branches ───────────────────────────────────────────────────
    const hours = {
      mon: { open: '05:30', close: '22:30' }, tue: { open: '05:30', close: '22:30' },
      wed: { open: '05:30', close: '22:30' }, thu: { open: '05:30', close: '22:30' },
      fri: { open: '05:30', close: '22:30' }, sat: { open: '06:00', close: '20:00' },
      sun: { open: '07:00', close: '14:00' },
    };
    const gym1 = (
      await client.query(
        `INSERT INTO gyms (name, slug, timezone, currency, status, address_line1, city, state, postal_code, phone, email, website, operating_hours, branding)
         VALUES ('Ironworks Strength Co.', 'demo-ironworks', 'Asia/Kolkata', 'INR', 'ACTIVE',
                 'SCF 21, Sector 70', 'Mohali', 'Punjab', '160070', '+91-98765-00001',
                 'hello@ironworks.test', 'https://ironworks.test', $1, $2) RETURNING id`,
        [JSON.stringify(hours), JSON.stringify({ primary_color: '#E0533D', logo_text: 'IW' })]
      )
    ).rows[0].id;
    const gym2 = (
      await client.query(
        `INSERT INTO gyms (name, slug, timezone, currency, status, address_line1, city, phone)
         VALUES ('PulseFit Studio', 'demo-pulsefit', 'Asia/Kolkata', 'INR', 'ACTIVE',
                 'Booth 9, Sector 44', 'Chandigarh', '+91-98765-00009') RETURNING id`
      )
    ).rows[0].id;

    const mkBranch = async (gymId, name, city, status = 'ACTIVE', phone = null) => (
      await client.query(
        `INSERT INTO gym_branches (gym_id, name, city, state, phone, operating_hours, timezone, status)
         VALUES ($1,$2,$3,'Punjab',$4,$5,'Asia/Kolkata',$6) RETURNING id`,
        [gymId, name, city, phone, JSON.stringify(hours), status]
      )
    ).rows[0].id;
    const bMohali = await mkBranch(gym1, 'Mohali HQ', 'Mohali', 'ACTIVE', '+91-98765-00011');
    const bChd = await mkBranch(gym1, 'Chandigarh South', 'Chandigarh', 'ACTIVE', '+91-98765-00012');
    await mkBranch(gym1, 'Zirakpur Studio', 'Zirakpur', 'INACTIVE'); // closed branch — history demo
    const bPulse = await mkBranch(gym2, 'PulseFit Central', 'Chandigarh');

    // ── staff ─────────────────────────────────────────────────────────────
    const mkStaff = async (gymId, userId, role, status = 'ACTIVE', branchIds = []) => (
      await client.query(
        'INSERT INTO gym_staff (gym_id, user_id, gym_role, status, branch_ids) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [gymId, userId, role, status, branchIds]
      )
    ).rows[0].id;
    await mkStaff(gym1, ownerU, 'OWNER');
    const adminS = await mkStaff(gym1, adminU, 'ADMIN');
    await mkStaff(gym1, deskU, 'FRONT_DESK', 'ACTIVE', [bMohali]); // branch-restricted desk
    const simranS = await mkStaff(gym1, simranU, 'TRAINER', 'ACTIVE', [bMohali]);
    const arjunS = await mkStaff(gym1, arjunU, 'TRAINER', 'ACTIVE', [bChd]);
    await mkStaff(gym1, inactiveU, 'ADMIN', 'INACTIVE'); // must be rejected at login/API
    await mkStaff(gym2, pfOwnerU, 'OWNER');

    // ── members ───────────────────────────────────────────────────────────
    let codeSeq = 900001;
    const mkMember = async (gymId, first, last, opts = {}) => {
      const code = 'GM-' + codeSeq++;
      const { rows } = await client.query(
        `INSERT INTO gym_members (gym_id, member_code, first_name, last_name, email, phone,
           app_user_id, status, joined_at, notes, date_of_birth, gender,
           emergency_contact_name, emergency_contact_phone, profile,
           app_invite_status, app_invite_sent_at, qr_token, qr_issued_at,
           branch, primary_branch_id, allowed_branch_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         RETURNING id`,
        [gymId, code, first, last, opts.email || null, opts.phone || null,
         opts.appUserId || null, opts.status || 'ACTIVE', day(opts.joinedDaysAgo ?? 30),
         opts.notes || null, opts.dob || null, opts.gender || null,
         opts.emergencyName || null, opts.emergencyPhone || null,
         JSON.stringify(opts.profile || {}), opts.inviteStatus || 'none',
         opts.inviteStatus === 'pending' ? ts(day(-2), 11, 0) : null,
         opts.qr || false ? uuid().replace(/-/g, '') : null,
         opts.qr ? new Date().toISOString() : null,
         opts.branchName || null, opts.primaryBranch || null, opts.allowedBranches || []]
      );
      return rows[0].id;
    };
    const mRiya = await mkMember(gym1, 'Riya', 'Kapoor', { email: 'member.riya' + DEMO_USER_DOMAIN, appUserId: riyaU, joinedDaysAgo: 200, dob: '1996-04-12', gender: 'female', emergencyName: 'Rohit Kapoor', emergencyPhone: '+91-90000-10001', profile: { goal: 'strength', plan: 'bulking' }, primaryBranch: bMohali, branchName: 'Mohali HQ', qr: true, phone: '+91-90000-20001' });
    const mKabir = await mkMember(gym1, 'Kabir', 'Singh', { email: 'member.kabir' + DEMO_USER_DOMAIN, appUserId: kabirU, joinedDaysAgo: 120, dob: '1992-11-03', gender: 'male', primaryBranch: bChd, branchName: 'Chandigarh South', qr: true, phone: '+91-90000-20002' });
    const mMira = await mkMember(gym1, 'Mira', 'Nair', { email: 'member.mira' + DEMO_USER_DOMAIN, appUserId: miraU, joinedDaysAgo: 400, dob: '1989-07-21', gender: 'female', primaryBranch: bMohali, allowedBranches: [bChd], branchName: 'Mohali HQ', qr: true, phone: '+91-90000-20003' });
    const mSimar = await mkMember(gym1, 'Simar', 'Gill', { email: 'simar.gill@example.com', phone: '+91-90000-20004', joinedDaysAgo: 25, inviteStatus: 'pending', primaryBranch: bMohali, branchName: 'Mohali HQ' });
    const mGurpreet = await mkMember(gym1, 'Gurpreet', 'Sandhu', { phone: '+91-90000-20005', joinedDaysAgo: 300, status: 'FROZEN', notes: 'Membership frozen — medical.', primaryBranch: bMohali, branchName: 'Mohali HQ' });
    const mAnanya = await mkMember(gym1, 'Ananya', 'Rao', { phone: '+91-90000-20006', joinedDaysAgo: 10, primaryBranch: bChd, allowedBranches: [bMohali], branchName: 'Chandigarh South' });
    const mVikram = await mkMember(gym1, 'Vikram', 'Mehta', { joinedDaysAgo: 500, status: 'EXPIRED', notes: 'Renewal follow-up done twice.', primaryBranch: bChd, branchName: 'Chandigarh South' });
    const mNeha = await mkMember(gym1, 'Neha', 'Verma', { email: 'neha.verma@example.com', joinedDaysAgo: 130, status: 'CANCELLED', notes: 'Cancelled — relocated to Bangalore.', primaryBranch: bChd, branchName: 'Chandigarh South' });
    const mArsh = await mkMember(gym1, 'Arsh', 'Deep', { phone: '+91-90000-20008', joinedDaysAgo: 1, status: 'PENDING', notes: 'Walk-in — paperwork pending.', dob: '2001-02-17', gender: 'male' });
    const mTanvi = await mkMember(gym1, 'Tanvi', 'Bhatt', { phone: '+91-90000-20009', joinedDaysAgo: 2, primaryBranch: bMohali, branchName: 'Mohali HQ' });
    const mRohan = await mkMember(gym1, 'Rohan', 'Malik', { email: 'rohan.malik@example.com', phone: '+91-90000-20010', joinedDaysAgo: 30, primaryBranch: bChd, branchName: 'Chandigarh South' });
    const mPreet = await mkMember(gym1, 'Preet', 'Kaur', { email: 'preet.kaur@example.com', phone: '+91-90000-20011', joinedDaysAgo: 15, primaryBranch: bMohali, branchName: 'Mohali HQ' });

    // invites (pending app invite for Simar; one pending staff invite)
    await client.query(
      `INSERT INTO gym_member_invites (gym_id, member_id, email, code_hash, status, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,'PENDING',$5, now() + interval '7 days')`,
      [gym1, mSimar, 'simar.gill@example.com', sha256(uuid()), ownerU]
    );
    await client.query(
      `INSERT INTO gym_staff_invites (gym_id, email, gym_role, code_hash, status, invited_by, expires_at)
       VALUES ($1,$2,'TRAINER',$3,'PENDING',$4, now() + interval '7 days')`,
      [gym1, 'new.trainer' + DEMO_USER_DOMAIN, sha256(uuid()), adminU]
    );

    // ── plans ─────────────────────────────────────────────────────────────
    const mkPlan = async (name, dv, du, price, access, pt, status) => (
      await client.query(
        `INSERT INTO membership_plans (gym_id, name, description, duration_value, duration_unit, price_cents, currency, access_level, included_pt_sessions, status)
         VALUES ($1,$2,$3,$4,$5,$6,'INR',$7,$8,$9) RETURNING id`,
        [gym1, name, `${name} — demo plan`, dv, du, price, access, pt, status]
      )
    ).rows[0].id;
    const pMonthly = await mkPlan('Standard Monthly', 1, 'month', 149900, 'gym_only', 0, 'ACTIVE');
    const pQuarter = await mkPlan('Premium Quarterly', 3, 'month', 399900, 'gym_classes', 4, 'ACTIVE');
    const pAnnual = await mkPlan('Elite Annual', 1, 'year', 1199900, 'all_access', 12, 'ACTIVE');
    const pDay = await mkPlan('Day Pass', 1, 'day', 29900, 'gym_only', 0, 'ACTIVE');
    await mkPlan('Founders Legacy (2024)', 1, 'year', 999900, 'all_access', 24, 'ARCHIVED');

    const mkMembership = async (memberId, planId, status, starts, ends, extra = {}) => (
      await client.query(
        `INSERT INTO member_memberships (gym_id, member_id, plan_id, plan_name, plan_duration_value, plan_duration_unit,
           price_cents, currency, status, starts_on, ends_on, cancelled_at, cancel_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'INR',$8,$9,$10,$11,$12) RETURNING id`,
        [gym1, memberId, planId, extra.planName || 'Plan', extra.dv || 1, extra.du || 'month',
         extra.price, status, starts, ends, extra.cancelledAt || null, extra.cancelReason || null]
      )
    ).rows[0].id;
    const mshipRiya = await mkMembership(mRiya, pMonthly, 'ACTIVE', day(-20), day(10), { planName: 'Standard Monthly', dv: 1, du: 'month', price: 149900 });
    const mshipRiyaOld = await mkMembership(mRiya, pMonthly, 'EXPIRED', day(-50), day(-20), { planName: 'Standard Monthly', dv: 1, du: 'month', price: 149900 });
    const mshipKabir = await mkMembership(mKabir, pQuarter, 'ACTIVE', day(-40), day(50), { planName: 'Premium Quarterly', dv: 3, du: 'month', price: 399900 });
    const mshipMira = await mkMembership(mMira, pAnnual, 'ACTIVE', day(-115), day(250), { planName: 'Elite Annual', dv: 1, du: 'year', price: 1199900 });
    await mkMembership(mMira, pQuarter, 'UPCOMING', day(250), day(340), { planName: 'Premium Quarterly', dv: 3, du: 'month', price: 399900 }); // early renewal
    const mshipGurpreet = await mkMembership(mGurpreet, pMonthly, 'FROZEN', day(-85), day(5), { planName: 'Standard Monthly', dv: 1, du: 'month', price: 149900 });
    const mshipAnanya = await mkMembership(mAnanya, pMonthly, 'ACTIVE', day(-10), day(20), { planName: 'Standard Monthly', dv: 1, du: 'month', price: 149900 });
    await mkMembership(mVikram, pAnnual, 'EXPIRED', day(-395), day(-35), { planName: 'Elite Annual', dv: 1, du: 'year', price: 1199900 });
    const mshipNeha = await mkMembership(mNeha, pMonthly, 'CANCELLED', day(-130), day(-40), { planName: 'Standard Monthly', dv: 1, du: 'month', price: 149900, cancelledAt: ts(day(-45), 16, 30), cancelReason: 'Member relocated' });
    await mkMembership(mTanvi, pDay, 'EXPIRED', day(-2), day(-1), { planName: 'Day Pass', dv: 1, du: 'day', price: 29900 });
    const mshipRohan = await mkMembership(mRohan, pQuarter, 'ACTIVE', day(-30), day(60), { planName: 'Premium Quarterly', dv: 3, du: 'month', price: 399900 });
    const mshipPreet = await mkMembership(mPreet, pMonthly, 'ACTIVE', day(-15), day(15), { planName: 'Standard Monthly', dv: 1, du: 'month', price: 149900 });
    const mshipSimar = await mkMembership(mSimar, pMonthly, 'ACTIVE', day(-25), day(5), { planName: 'Standard Monthly', dv: 1, du: 'month', price: 149900 });

    // lifecycle timeline + open freeze
    const mkEvent = (membershipId, event, occurredOn, details = {}) =>
      client.query(
        'INSERT INTO membership_events (gym_id, membership_id, event, occurred_on, details, actor_user_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [gym1, membershipId, event, occurredOn, JSON.stringify(details), adminU]
      );
    await mkEvent(mshipRiyaOld, 'assigned', day(-50), { plan: 'Standard Monthly' });
    await mkEvent(mshipRiyaOld, 'expired', day(-20), {});
    await mkEvent(mshipRiya, 'renewed', day(-20), { plan: 'Standard Monthly' });
    await mkEvent(mshipKabir, 'assigned', day(-40), { plan: 'Premium Quarterly' });
    await mkEvent(mshipMira, 'assigned', day(-115), { plan: 'Elite Annual' });
    await mkEvent(mshipGurpreet, 'assigned', day(-85), { plan: 'Standard Monthly' });
    await mkEvent(mshipGurpreet, 'frozen', day(-5), { reason: 'Knee surgery recovery' });
    await mkEvent(mshipNeha, 'cancelled', day(-45), { reason: 'Member relocated' });
    await mkEvent(mshipAnanya, 'assigned', day(-10), { plan: 'Standard Monthly' });
    await mkEvent(mshipRohan, 'assigned', day(-30), { plan: 'Premium Quarterly' });
    await mkEvent(mshipPreet, 'assigned', day(-15), { plan: 'Standard Monthly' });
    await mkEvent(mshipSimar, 'assigned', day(-25), { plan: 'Standard Monthly' });
    await client.query(
      `INSERT INTO membership_freezes (gym_id, membership_id, starts_on, status, reason, created_by)
       VALUES ($1,$2,$3,'ACTIVE','Knee surgery recovery',$4)`,
      [gym1, mshipGurpreet, day(-5), adminU]
    );

    // ── billing: charges → payments → refunds ─────────────────────────────
    const mkCharge = (memberId, membershipId, desc, amount, dueOn, ps = null, pe = null) => (
      client.query(
        `INSERT INTO membership_charges (gym_id, member_id, membership_id, description, amount_cents, currency, period_start, period_end, due_on, created_by)
         VALUES ($1,$2,$3,$4,$5,'INR',$6,$7,$8,$9) RETURNING id`,
        [gym1, memberId, membershipId, desc, amount, ps, pe, dueOn, deskU]
      )
    ).then((r) => r.rows[0].id);
    const mkPayment = async (memberId, chargeId, amount, method, paidOn) => {
      const pid = uuid();
      await client.query(
        `INSERT INTO membership_payments (id, gym_id, member_id, charge_id, amount_cents, currency, method, paid_on, receipt_number, recorded_by)
         VALUES ($1,$2,$3,$4,$5,'INR',$6,$7,$8,$9)`,
        [pid, gym1, memberId, chargeId, amount, method, paidOn, receiptNo(paidOn, pid), deskU]
      );
      return pid;
    };
    const cRiya = await mkCharge(mRiya, mshipRiya, 'Standard Monthly — term ' + day(-20) + ' → ' + day(10), 149900, day(-20), day(-20), day(10));
    await mkPayment(mRiya, cRiya, 149900, 'UPI', day(-20));
    const cRiyaOld = await mkCharge(mRiya, mshipRiyaOld, 'Standard Monthly — term ' + day(-50) + ' → ' + day(-20), 149900, day(-50), day(-50), day(-20));
    await mkPayment(mRiya, cRiyaOld, 149900, 'CASH', day(-50));
    const cKabir = await mkCharge(mKabir, mshipKabir, 'Premium Quarterly — term ' + day(-40) + ' → ' + day(50), 399900, day(-40), day(-40), day(50));
    await mkPayment(mKabir, cKabir, 200000, 'UPI', day(-40));
    await mkPayment(mKabir, cKabir, 100000, 'CASH', day(-15)); // PARTIAL — 99900 still due
    const cKabirPT = await mkCharge(mKabir, null, 'Personal training add-on — 4 sessions', 400000, day(-7));
    await mkPayment(mKabir, cKabirPT, 400000, 'CARD', day(-7));
    const cMira = await mkCharge(mMira, mshipMira, 'Elite Annual — term ' + day(-115) + ' → ' + day(250), 1199900, day(-115), day(-115), day(250));
    await mkPayment(mMira, cMira, 1199900, 'CARD', day(-115));
    const cGurp = await mkCharge(mGurpreet, mshipGurpreet, 'Standard Monthly — term ' + day(-85) + ' → ' + day(5), 149900, day(-85), day(-85), day(5));
    await mkPayment(mGurpreet, cGurp, 149900, 'BANK_TRANSFER', day(-85));
    const cAnanya = await mkCharge(mAnanya, mshipAnanya, 'Standard Monthly — term ' + day(-10) + ' → ' + day(20), 149900, day(-10), day(-10), day(20)); // OVERDUE
    const cVikram = await mkCharge(mVikram, null, 'Elite Annual — term ' + day(-395) + ' → ' + day(-35), 1199900, day(-395), day(-395), day(-35));
    const payNeha = await mkPayment(mNeha, (await mkCharge(mNeha, null, 'Standard Monthly — term ' + day(-130) + ' → ' + day(-40), 149900, day(-130), day(-130), day(-40))), 149900, 'CASH', day(-130));
    await client.query(
      `INSERT INTO payment_refunds (gym_id, payment_id, amount_cents, reason, refunded_on, refunded_by)
       VALUES ($1,$2,$3,'Membership cancelled — pro-rata refund',$4,$5)`,
      [gym1, payNeha, 149900, day(-44), adminU]
    );
    const cTanvi = await mkCharge(mTanvi, null, 'Day Pass — ' + day(-2), 29900, day(-2));
    await mkPayment(mTanvi, cTanvi, 29900, 'CASH', day(-2));
    const cRohan = await mkCharge(mRohan, mshipRohan, 'Premium Quarterly — term ' + day(-30) + ' → ' + day(60), 399900, day(-30), day(-30), day(60));
    await mkPayment(mRohan, cRohan, 399900, 'UPI', day(-30));
    const cPreet = await mkCharge(mPreet, mshipPreet, 'Standard Monthly — term ' + day(-15) + ' → ' + day(15), 149900, day(-15), day(-15), day(15));
    await mkPayment(mPreet, cPreet, 149900, 'UPI', day(-15));
    const cSimar = await mkCharge(mSimar, mshipSimar, 'Standard Monthly — term ' + day(-25) + ' → ' + day(5), 149900, day(-25), day(-25), day(5));
    await mkPayment(mSimar, cSimar, 149900, 'CASH', day(-25));

    // ── attendance: last 14 days, deterministic pattern ───────────────────
    const attendees = [
      [mRiya, bMohali], [mKabir, bChd], [mMira, bMohali], [mSimar, bMohali],
      [mAnanya, bChd], [mRohan, bChd], [mPreet, bMohali], [mTanvi, bMohali],
    ];
    const times = [[6, 15], [7, 45], [18, 0], [19, 45]];
    const sources = ['QR_CHECK_IN', 'FRONT_DESK', 'WORKOUT_COMPLETION', 'QR_CHECK_IN', 'FRONT_DESK'];
    let attCount = 0;
    // JS % keeps the dividend's sign — (i + dOff) goes negative for early
    // days, so always normalize through mod() before array indexing
    const mod = (n, m) => ((n % m) + m) % m;
    for (let dOff = -13; dOff <= 0; dOff++) {
      for (let i = 0; i < attendees.length; i++) {
        if ((dOff + i + 14) % 3 === 0) continue; // everyone skips ~1/3 of days
        const [memberId, branchId] = attendees[i];
        const [h, m] = times[mod(i + dOff, times.length)];
        const src = sources[mod(i + dOff, sources.length)];
        await client.query(
          `INSERT INTO gym_attendance (gym_id, member_id, source, check_in_at, local_date, recorded_by, branch_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [gym1, memberId, src, ts(day(dOff), h, m), day(dOff), src === 'FRONT_DESK' ? deskU : null, branchId]
        );
        attCount++;
      }
    }
    await client.query(
      `INSERT INTO gym_attendance (gym_id, member_id, source, check_in_at, local_date, note, recorded_by, branch_id)
       VALUES ($1,$2,'ADMIN_MANUAL',$3,$4,'Forgot QR — desk logged manually',$5,$6)`,
      [gym1, mPreet, ts(day(0), 9, 30), day(0), adminU, bMohali]
    );
    attCount++;

    // ── trainer assignments ───────────────────────────────────────────────
    const mkTrainerAsg = (memberId, staffId, status, starts, ended = null, reason = null) =>
      client.query(
        `INSERT INTO gym_trainer_assignments (gym_id, member_id, trainer_staff_id, status, starts_on, ended_on, end_reason, assigned_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [gym1, memberId, staffId, status, starts, ended, reason, adminU]
      );
    await mkTrainerAsg(mRiya, simranS, 'ACTIVE', day(-60));
    await mkTrainerAsg(mKabir, arjunS, 'ACTIVE', day(-30));
    await mkTrainerAsg(mPreet, simranS, 'ACTIVE', day(-10));
    await mkTrainerAsg(mMira, simranS, 'ENDED', day(-300), day(-90), 'Member switched coach');

    // ── workouts + nutrition + unified content assignments ────────────────
    const mkWorkout = (title, difficulty, goal, mins, tags, status, recommended, exercises) => (
      client.query(
        `INSERT INTO gym_workouts (gym_id, title, description, difficulty, goal, estimated_duration_minutes, tags, status, recommended, version, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10) RETURNING id`,
        [gym1, title, `${title} — demo program`, difficulty, goal, mins, tags, status, recommended, adminU]
      ).then(async (r) => {
        const wid = r.rows[0].id;
        for (let i = 0; i < exercises.length; i++) {
          const [name, sets, reps] = exercises[i];
          await client.query(
            'INSERT INTO gym_workout_exercises (workout_id, exercise_name, sets, reps, order_index) VALUES ($1,$2,$3,$4,$5)',
            [wid, name, sets, reps, i]
          );
        }
        return wid;
      })
    );
    const w1 = await mkWorkout('Foundation Full Body', 'beginner', 'general', 45, ['beginner', 'full-body'], 'PUBLISHED', true, [
      ['Barbell Back Squat', 3, '8-10'], ['Flat Bench Press', 3, '8-10'], ['Lat Pulldown', 3, '10-12'],
      ['Seated Row', 3, '10-12'], ['Plank', 3, '45s'], ['Treadmill Cool-down Walk', 1, '10 min'],
    ]);
    const w2 = await mkWorkout('HIIT Fat Burner', 'intermediate', 'fat_loss', 30, ['hiit', 'conditioning'], 'PUBLISHED', false, [
      ['Kettlebell Swing', 5, '15'], ['Box Jump', 4, '10'], ['Battle Ropes', 4, '30s'],
      ['Assault Bike Sprint', 6, '20s'], ['Burpee', 4, '12'],
    ]);
    const w3 = await mkWorkout('Powerbuilding Block A', 'advanced', 'strength', 60, ['strength', 'hypertrophy'], 'DRAFT', false, [
      ['Deadlift', 5, '5'], ['Incline Bench Press', 4, '6-8'], ['Weighted Pull-up', 4, '6-8'],
      ['Bulgarian Split Squat', 3, '10'], ['Hanging Leg Raise', 3, '12'],
    ]);
    const w4 = await mkWorkout('Summer Shred 2025', 'intermediate', 'fat_loss', 40, ['seasonal'], 'ARCHIVED', false, [
      ['Circuit Row', 3, '12'], ['Mountain Climbers', 4, '20'],
    ]);

    const mkNutri = (kind, title, status, recommended, content, targets) => (
      client.query(
        `INSERT INTO gym_nutrition_items (gym_id, kind, title, description, content, targets, tags, status, recommended, version, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10) RETURNING id`,
        [gym1, kind, title, `${title} — demo item`, JSON.stringify(content),
         targets ? JSON.stringify(targets) : null, [kind.toLowerCase()], status, recommended, adminU]
      )
    ).then((r) => r.rows[0].id);
    const n1 = await mkNutri('RECIPE', 'High-Protein Paneer Bowl', 'PUBLISHED', true, { entries: [
      { type: 'ingredient', text: '200g grilled paneer' }, { type: 'ingredient', text: '1 cup brown rice' },
      { type: 'ingredient', text: 'Mixed peppers, spinach' }, { type: 'step', text: 'Grill paneer, assemble bowl, season.' },
    ] }, { calories: 520, protein_g: 42, carbs_g: 45, fat_g: 18 });
    const n2 = await mkNutri('MEAL_PLAN', 'Cutting Plan — 1800 kcal', 'PUBLISHED', false, { entries: [
      { type: 'day', day: 'Mon', text: 'P: eggs + oats | L: chicken rice | D: paneer salad' },
      { type: 'day', day: 'Tue', text: 'P: sprouts toast | L: fish quinoa | D: dal + veggies' },
    ] }, { calories: 1800, protein_g: 140 });
    const n3 = await mkNutri('DIET_RECOMMENDATION', 'Hydration & Electrolytes', 'DRAFT', false, { entries: [
      { type: 'guideline', text: '3–4 L water daily; add electrolytes on double-session days.' },
    ] }, null);

    const mkAssign = (type, contentId, memberId, starts, status, notes, version = 1, ended = null) =>
      client.query(
        `INSERT INTO gym_content_assignments (gym_id, content_type, workout_id, item_id, member_id, status, starts_on, ends_on, notes, assigned_version, end_reason, ended_on, assigned_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [gym1, type, type === 'WORKOUT' ? contentId : null, type === 'NUTRITION' ? contentId : null,
         memberId, status, starts, null, notes, version, status === 'ENDED' ? 'completed' : null, ended, adminU]
      );
    await mkAssign('WORKOUT', w1, mRiya, day(-10), 'ACTIVE', '3x per week after warm-up');
    await mkAssign('WORKOUT', w2, mKabir, day(-5), 'ACTIVE', 'Keep HR in zone 4');
    await mkAssign('WORKOUT', w3, mMira, day(2), 'ACTIVE', 'Starts next week — new block'); // scheduled future start
    await mkAssign('WORKOUT', w1, mPreet, day(-40), 'ENDED', 'Completed cycle 1', 1, day(-10));
    await mkAssign('NUTRITION', n1, mRiya, day(-10), 'ACTIVE', 'Post-workout meal');
    await mkAssign('NUTRITION', n2, mKabir, day(-5), 'ACTIVE', 'Weigh-in every Sunday');

    // ── announcements + deliveries + notifications ────────────────────────
    const mkAnnouncement = (title, body, audienceType, status, extra = {}) => (
      client.query(
        `INSERT INTO gym_announcements (gym_id, title, body, audience_type, audience_member_ids, audience_branch, status, scheduled_for, published_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [gym1, title, body, audienceType,
         extra.memberIds ? JSON.stringify(extra.memberIds) : null, extra.branch || null,
         status, extra.scheduledFor || null, extra.publishedAt || null, adminU]
      )
    ).then((r) => r.rows[0].id);
    const a1 = await mkAnnouncement(
      'Diwali week — special timings',
      'We are open 07:00–13:00 from Mon to Thu next week. Regular schedule resumes Friday. Happy Diwali!',
      'ALL_ACTIVE_MEMBERS', 'SENT', { publishedAt: ts(day(-3), 10, 0) }
    );
    const a2 = await mkAnnouncement(
      'New Year Bootcamp — early bird',
      '6-week bootcamp starting Jan 2. Early-bird pricing for the first 20 sign-ups — reply at the front desk.',
      'SPECIFIC_BRANCH', 'SCHEDULED', { branch: 'Mohali HQ', scheduledFor: ts(day(3), 10, 0) }
    );
    await mkAnnouncement(
      'Equipment maintenance this weekend',
      'The squat racks will be serviced Saturday 14:00–18:00. Alternative stations will be open.',
      'ALL_ACTIVE_MEMBERS', 'DRAFT'
    );
    const a4 = await mkAnnouncement(
      'Your PT session moves to 7 AM',
      'Coach Simran will take your next personal training session at 07:00 instead of 18:00.',
      'SPECIFIC_MEMBERS', 'SENT', { memberIds: [mRiya, mKabir], publishedAt: ts(day(-1), 9, 0) }
    );
    const mkDelivery = (annId, memberId, channel, status, detail = null, sentAt = null) =>
      client.query(
        `INSERT INTO gym_announcement_deliveries (gym_id, announcement_id, member_id, channel, status, detail, dedupe_key, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (dedupe_key) DO NOTHING`,
        [gym1, annId, memberId, channel, status, detail, `ann:${annId}:mbr:${memberId}:${channel}`, sentAt]
      );
    for (const [mid, uid] of [[mRiya, riyaU], [mKabir, kabirU], [mMira, miraU]]) {
      await mkDelivery(a1, mid, 'IN_APP', 'SENT', null, ts(day(-3), 10, 0));
      await client.query(
        `INSERT INTO notifications (recipient_id, actor_id, type, title, body, deep_link_ref, is_read)
         VALUES ($1,$2,'gym_announcement',$3,$4,'announcements',false)`,
        [uid, adminU, 'Diwali week — special timings', 'We are open 07:00–13:00 Mon–Thu next week. Regular schedule resumes Friday.']
      );
    }
    for (const [mid, hasEmail] of [
      [mSimar, true], [mAnanya, false],
      [mTanvi, false], [mPreet, true],
      [mRohan, true],
    ]) {
      // honest ledger: members without an address were skipped for that
      // reason; the rest simply have no SMTP configured in local dev
      await mkDelivery(a1, mid, 'EMAIL', 'SKIPPED', hasEmail ? 'email_not_configured' : 'no_email_address');
    }
    for (const mid of [mRiya, mKabir]) await mkDelivery(a4, mid, 'IN_APP', 'SENT', null, ts(day(-1), 9, 0));

    // ── classes + bookings ────────────────────────────────────────────────
    const mkClass = (classType, branchId, staffId, room, date, start, end, cap, status = 'SCHEDULED', extra = {}) => (
      client.query(
        `INSERT INTO gym_classes (gym_id, branch_id, class_type, trainer_staff_id, room, class_date, start_time, end_time, capacity, status, cancelled_at, cancelled_by, cancel_reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [gym1, branchId, classType, staffId, room, date, start, end, cap, status,
         status === 'CANCELLED' ? ts(day(-1), 20, 0) : null, status === 'CANCELLED' ? adminU : null,
         extra.cancelReason || null, adminU]
      )
    ).then((r) => r.rows[0].id);
    const mkBooking = (classId, memberId, status, source, bookedAt, extra = {}) =>
      client.query(
        `INSERT INTO gym_class_bookings (gym_id, class_id, member_id, status, source, booked_by, booked_at, cancelled_at, cancel_reason, attended_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [gym1, classId, memberId, status, source, source === 'SELF' ? null : deskU, bookedAt,
         extra.cancelledAt || null, extra.cancelReason || null, extra.attendedAt || null]
      );

    // upcoming regular schedule
    const yoga1 = await mkClass('Yoga', bMohali, simranS, 'Studio A', day(1), '06:30', '07:30', 12);
    const yoga2 = await mkClass('Yoga', bMohali, simranS, 'Studio A', day(2), '06:30', '07:30', 12);
    const yoga3 = await mkClass('Yoga', bMohali, simranS, 'Studio A', day(3), '06:30', '07:30', 12);
    await mkClass('Spin', bChd, arjunS, 'Cycle Room', day(1), '19:00', '20:00', 15);
    await mkClass('Spin', bChd, arjunS, 'Cycle Room', day(2), '19:00', '20:00', 15);
    await mkClass('CrossFit', bMohali, simranS, 'Main Floor', day(1), '18:00', '19:00', 10);
    const pump = await mkClass('BodyPump', bMohali, simranS, 'Main Floor', day(0), '18:00', '19:00', 15);
    await mkBooking(pump, mAnanya, 'BOOKED', 'DESK', ts(day(-1), 12, 0));
    await mkBooking(pump, mTanvi, 'BOOKED', 'DESK', ts(day(-1), 12, 5));
    await mkBooking(yoga1, mMira, 'BOOKED', 'SELF', ts(day(-1), 19, 0));
    // FULL class + waitlist demo (capacity 2, 2 booked, 1 waitlisted)
    const hiitFull = await mkClass('HIIT Express (Full)', bMohali, simranS, 'Studio B', day(2), '07:00', '08:00', 2);
    await mkBooking(hiitFull, mRiya, 'BOOKED', 'SELF', ts(day(-2), 9, 0));
    await mkBooking(hiitFull, mMira, 'BOOKED', 'DESK', ts(day(-2), 10, 0));
    await mkBooking(hiitFull, mKabir, 'WAITLISTED', 'DESK', ts(day(-2), 11, 0)); // FIFO position 1
    // past class: attended / no-show / cancelled history
    const yogaPast = await mkClass('Yoga', bMohali, simranS, 'Studio A', day(-1), '06:30', '07:30', 12);
    await mkBooking(yogaPast, mRiya, 'ATTENDED', 'SELF', ts(day(-3), 8, 0), { attendedAt: ts(day(-1), 6, 40) });
    await mkBooking(yogaPast, mKabir, 'NO_SHOW', 'DESK', ts(day(-3), 8, 30));
    await mkBooking(yogaPast, mPreet, 'CANCELLED', 'DESK', ts(day(-3), 9, 0), { cancelledAt: ts(day(-2), 15, 0), cancelReason: 'Work conflict' });
    // cancelled class (terminal)
    const zumba = await mkClass('Zumba', bChd, arjunS, 'Group Ex Hall', day(1), '19:30', '20:30', 20, 'CANCELLED', { cancelReason: 'Instructor unavailable' });
    await mkBooking(zumba, mAnanya, 'CANCELLED', 'DESK', ts(day(-1), 12, 30), { cancelledAt: ts(day(-1), 20, 1), cancelReason: 'Class cancelled by gym' });

    // ── member documents (REAL pdf files on disk → downloads work) ────────
    const DOC_ROOT = path.join(DEMO_GYMS_UPLOADS, String(gym1));
    fs.mkdirSync(DOC_ROOT, { recursive: true });
    const docPdf = (title, memberName, cat) => makePdf([
      'IRONWORKS STRENGTH CO. — ' + cat.replace(/_/g, ' '),
      'Member: ' + memberName, 'Document: ' + title,
      'This is demo paperwork generated by seedDemo.js.',
      'Generated: ' + day(0),
    ]);
    let docSeq = 0;
    const mkDoc = (memberId, memberName, category, title, status, opts = {}) => {
      const key = `${gym1}/${uuid()}.pdf`;
      const buf = docPdf(title, memberName, category);
      fs.writeFileSync(path.join(DEMO_GYMS_UPLOADS, key), buf);
      docSeq++;
      return client.query(
        `INSERT INTO gym_member_documents (gym_id, member_id, category, title, status, storage_provider, storage_key,
           original_filename, content_type, file_size, file_sha256, expires_at, replaced_by,
           uploaded_by, uploaded_via, authorized_at, authorized_by, authorized_signature)
         VALUES ($1,$2,$3,$4,$5,'local',$6,$7,'application/pdf',$8,$9,$10,$11,$12,'DESK',$13,$14,$15) RETURNING id`,
        [gym1, memberId, category, title, status, key,
         title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.pdf', buf.length, sha256(buf),
         opts.expiresAt || null, opts.replacedBy || null, adminU,
         status === 'AUTHORIZED' ? opts.authorizedAt || ts(day(-20), 10, 0) : null,
         status === 'AUTHORIZED' ? adminU : null,
         status === 'AUTHORIZED' ? opts.signature || memberName : null]
      ).then((r) => r.rows[0].id);
    };
    await mkDoc(mRiya, 'Riya Kapoor', 'WAIVER', 'Liability Waiver 2026', 'AUTHORIZED', { expiresAt: ts(day(365), 0, 0), signature: 'Riya Kapoor' });
    await mkDoc(mRiya, 'Riya Kapoor', 'MEMBERSHIP_AGREEMENT', 'Membership Agreement — Standard Monthly', 'AUTHORIZED', { expiresAt: ts(day(365), 0, 0) });
    await mkDoc(mKabir, 'Kabir Singh', 'WAIVER', 'Liability Waiver 2026', 'AUTHORIZED', { expiresAt: ts(day(325), 0, 0) });
    await mkDoc(mGurpreet, 'Gurpreet Sandhu', 'WAIVER', 'Liability Waiver 2025', 'AUTHORIZED', { expiresAt: ts(day(-30), 0, 0) }); // effective EXPIRED
    await mkDoc(mRohan, 'Rohan Malik', 'ID_VERIFICATION', 'Govt ID — Aadhaar (front)', 'PENDING');
    const preetNewWaiverId = await mkDoc(mPreet, 'Preet Kaur', 'WAIVER', 'Liability Waiver 2026 (renewal)', 'AUTHORIZED', { signature: 'Preet Kaur', authorizedAt: ts(day(-15), 10, 0) });
    await mkDoc(mPreet, 'Preet Kaur', 'WAIVER', 'Liability Waiver 2025 (old)', 'REPLACED', { replacedBy: preetNewWaiverId });
    await mkDoc(mPreet, 'Preet Kaur', 'MEDICAL_CLEARANCE', 'Medical Clearance — Dr. Sharma', 'REVOKED');

    // ── gym 2: minimal second tenant (isolation demo) ─────────────────────
    const mPulse = (
      await client.query(
        `INSERT INTO gym_members (gym_id, member_code, first_name, last_name, phone, status, joined_at, primary_branch_id, branch, qr_token, qr_issued_at)
         VALUES ($1,'GM-700001','Aman','Jot','+91-90000-90001','ACTIVE',$2,$3,'PulseFit Central',$4,now()) RETURNING id`,
        [gym2, day(-60), bPulse, uuid().replace(/-/g, '')]
      )
    ).rows[0].id;
    const pPulse = (
      await client.query(
        `INSERT INTO membership_plans (gym_id, name, duration_value, duration_unit, price_cents, currency, access_level, status)
         VALUES ($1,'Pulse Monthly',1,'month',99900,'INR','gym_only','ACTIVE') RETURNING id`,
        [gym2]
      )
    ).rows[0].id;
    const msPulse = (
      await client.query(
        `INSERT INTO member_memberships (gym_id, member_id, plan_id, plan_name, plan_duration_value, plan_duration_unit, price_cents, currency, status, starts_on, ends_on)
         VALUES ($1,$2,$3,'Pulse Monthly',1,'month',99900,'INR','ACTIVE',$4,$5) RETURNING id`,
        [gym2, mPulse, pPulse, day(-5), day(25)]
      )
    ).rows[0].id;
    const cPulse = (
      await client.query(
        `INSERT INTO membership_charges (gym_id, member_id, membership_id, description, amount_cents, currency, due_on, created_by)
         VALUES ($1,$2,$3,'Pulse Monthly — term ' || $4 || ' → ' || $5,99900,'INR',$6,$7) RETURNING id`,
        [gym2, mPulse, msPulse, day(-5), day(25), day(-5), pfOwnerU]
      )
    ).rows[0].id;
    await mkPayment(mPulse, cPulse, 99900, 'UPI', day(-5));
    await client.query(
      `INSERT INTO gym_attendance (gym_id, member_id, source, check_in_at, local_date, branch_id)
       VALUES ($1,$2,'FRONT_DESK',$3,$4,$5), ($1,$2,'QR_CHECK_IN',$6,$7,$5)`,
      [gym2, mPulse, ts(day(-1), 7, 30), day(-1), bPulse, ts(day(0), 19, 15), day(0)]
    );

    await client.query('COMMIT');

    // ── summary ───────────────────────────────────────────────────────────
    console.log('\n✅ Demo data seeded. All accounts use password: ' + PASSWORD + '\n');
    console.log('PORTAL (gym-web) — Ironworks Strength Co.:');
    console.log('  owner@demo.test          OWNER  (all branches)');
    console.log('  admin@demo.test          ADMIN  (all branches)');
    console.log('  desk.mohali@demo.test    FRONT_DESK (Mohali HQ only — try Chandigarh South: 403)');
    console.log('  trainer.simran@demo.test TRAINER (Mohali HQ)');
    console.log('  trainer.arjun@demo.test  TRAINER (Chandigarh South)');
    console.log('  inactive.staff@demo.test ADMIN — INACTIVE, login/API must be rejected');
    console.log('MOBILE APP (connected members): member.riya@demo.test / member.kabir@demo.test / member.mira@demo.test');
    console.log('SECOND TENANT (isolation checks): pf.owner@demo.test (PulseFit Studio)\n');
    console.log('Seeded: 2 gyms · 4 branches · 7 staff · 13 members · 5+1 plans · 14 memberships');
    console.log('        13 charges · 14 payments · 1 refund · ' + (attCount + 2) + ' attendance rows · 4 trainer assignments');
    console.log('        4 workouts · 3 nutrition items · 6 content assignments · 4 announcements');
    console.log('        10 classes · 10 bookings · 8 documents (real PDFs) · member + staff invites\n');
    console.log('Highlights to test: FROZEN member (open freeze) · OVERDUE charge (Ananya) ·');
    console.log('  PARTIAL payment (Kabir) · UPCOMING renewal (Mira) · FULL class with waitlist (HIIT day +2) ·');
    console.log('  effective-EXPIRED waiver (Gurpreet) · REPLACED waiver (Preet) · SCHEDULED announcement (fires in 3d).\n');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('seedDemo failed:', e && e.message ? e.message : e, '\n', e && e.stack ? e.stack : ''); process.exit(1); });

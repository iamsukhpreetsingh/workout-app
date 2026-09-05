// Gym Invitations — mobile-side helpers (Mobile M4).
//
// The backend owns the ENTIRE security model; this module only presents it:
//   • the invitation token (32-hex, returned once by the desk portal) is the
//     bearer credential — preview/decline/register are public token routes,
//     accept additionally requires the JWT
//   • identity is validated SERVER-SIDE: accept matches the logged-in
//     account's email against the invited email (403 on mismatch), register
//     derives the new account's email from the invitation row itself — the
//     client never supplies a GymMember id or claims a member directly
//   • every terminal state (EXPIRED / DECLINED / CANCELLED / already
//     ACCEPTED), gym unavailability and inactive membership is a backend
//     decision; the app renders the verdict, it never second-guesses it
//
// Deep links arrive as workouttracker://gym/invitation/<token> (standalone
// builds), exp://…/gym/invitation/<token> (Expo Go) and eventually https
// universal links — extractInvitationToken() accepts any URL carrying the
// gym/invitation/<token> path plus a bare pasted code. The token is the ONLY
// thing in the URL — no personal data (the preview endpoint reveals the
// invited email only to whoever holds the token, exactly like the portal).
import { api } from './api';

// The backend generates crypto.randomBytes(16).toString('hex') — 32 hex
// chars. Kept tolerant (16–64 hex) so staff invite codes or a future
// rotation don't strand the user; the server 404s anything unknown.
const TOKEN_RE = /^[a-f0-9]{16,64}$/i;

// Extract a raw invitation token from a deep-link URL or a pasted code.
// Returns the bare token, or null when this input isn't an invitation.
// Match the path anywhere in the URL so scheme variations (workouttracker://,
// exp://…/--/, https://) all resolve.
export function extractInvitationToken(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (TOKEN_RE.test(raw)) return raw.toLowerCase();
  const m = raw.match(/gym\/invitation\/([a-f0-9]{16,64})/i);
  if (m) return m[1].toLowerCase();
  return null;
}

export function isValidInviteToken(token) {
  return TOKEN_RE.test(String(token || ''));
}

// Case-insensitive email equality — the same normalization the backend
// applies when comparing the logged-in account to the invited email.
export function emailsMatch(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
    && !!String(a || '').trim();
}

// ── API wrappers (shape parity with the portal landing page) ────────────
// GET /gym/invite/:token — public. { type, gymName, gymStatus, role?,
//   memberName?, memberStatus?, membershipPlan?, email, status, ... }
export async function fetchInvitationPreview(token) {
  return api(`/gym/invite/${encodeURIComponent(token)}`, { skipAuth: true });
}

// POST /gym/invite/:token/accept — authenticated (Scenario 1). The backend
// verifies the account email against the invitation before linking.
export async function acceptInvitationByToken(token) {
  return api(`/gym/invite/${encodeURIComponent(token)}/accept`, { method: 'POST', body: {} });
}

// POST /gym/invite/:token/decline — public; the token proves possession.
export async function declineInvitationByToken(token) {
  return api(`/gym/invite/${encodeURIComponent(token)}/decline`, { method: 'POST', body: {}, skipAuth: true });
}

// POST /gym/invite/:token/register — Scenario 2 (no app account yet).
// Creates the User (role user, email = the invitation's — client never
// sends an email) AND links the existing GymMember atomically. Returns
// { ok, gymName, user, member } — NO session, so the caller logs in with
// the credentials just entered.
export async function registerWithInvitation(token, { name, password }) {
  return api(`/gym/invite/${encodeURIComponent(token)}/register`, {
    method: 'POST',
    body: { name, password },
    skipAuth: true,
  });
}

// ── presentation model for non-PENDING states ───────────────────────────
// Terminal states come from the preview (the backend computes EXPIRED from
// expires_at, everything else is the stored status). icon/tone drive the
// card's look; body explains what happened and what to do next.
export function describeInvitationState(status) {
  switch (status) {
    case 'ACCEPTED':
      return {
        icon: 'checkmark-circle',
        tone: 'ok',
        title: 'Already connected',
        body: 'This invitation was already accepted. Your gym membership is linked to your account — you can find your gym under Profile → My Gym.',
      };
    case 'DECLINED':
      return {
        icon: 'close-circle',
        tone: 'muted',
        title: 'Invitation declined',
        body: 'This invitation was declined earlier. If that was a mistake, ask your gym to send a new one.',
      };
    case 'EXPIRED':
      return {
        icon: 'time-outline',
        tone: 'warn',
        title: 'Invitation expired',
        body: 'This invitation has expired. Ask your gym to send a fresh one — they can re-invite you in seconds.',
      };
    case 'CANCELLED':
      return {
        icon: 'ban-outline',
        tone: 'muted',
        title: 'Invitation cancelled',
        body: 'Your gym cancelled this invitation. Contact the front desk if you still want to connect.',
      };
    default:
      return null;
  }
}

// Gym health banner — a PENDING invitation at a suspended/deactivated gym
// can't be used (the backend refuses with 403); surface it up front.
export function gymUnavailableReason(gymStatus) {
  if (gymStatus === 'SUSPENDED') return 'This gym is currently unavailable.';
  if (gymStatus === 'INACTIVE') return 'This gym is deactivated — ask them to reactivate before connecting.';
  return null;
}

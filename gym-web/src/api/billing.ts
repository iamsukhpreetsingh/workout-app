// Billing & payment ledger (Phase 9). Money crosses the API as integer
// minor units (paise); receipts are immutable — no edit/delete path exists.
import { api } from './client';

export interface Charge {
  id: string;
  gym_id: string;
  member_id: string;
  membership_id: string | null;
  description: string;
  amount_cents: number;
  currency: string;
  period_start: string | null;
  period_end: string | null;
  due_on: string;
  status: 'DUE' | 'PARTIAL' | 'PAID' | 'OVERDUE' | 'REFUNDED';
  paid_total: number;
  net_paid: number;
  outstanding_cents: number;
  first_name?: string;
  last_name?: string;
  member_code?: string;
}

export interface Payment {
  id: string;
  gym_id: string;
  member_id: string;
  charge_id: string;
  amount_cents: number;
  currency: string;
  method: 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER' | 'OTHER';
  paid_on: string;
  receipt_number: string;
  note: string | null;
  status: 'PAID' | 'PARTIAL' | 'REFUNDED';
  refund_total: number;
  first_name?: string;
  last_name?: string;
  member_code?: string;
  charge_description?: string;
  period_start?: string | null;
  period_end?: string | null;
  plan_name?: string | null;
  recorded_by_name?: string | null;
}

export interface BillingSummary {
  revenue_this_month: number;
  collected_total: number;
  due: number;
  overdue: number;
}

export interface Receipt {
  receipt_number: string;
  gym: { name: string; address: string | null; phone: string | null; email: string | null };
  member: { name: string; member_code: string; app_connected: boolean };
  plan: string;
  amount_cents: number;
  currency: string;
  date: string;
  method: string;
  covered_period: { from: string; to: string } | null;
  status: string;
}

export const getBillingSummary = (gymId: string) =>
  api<BillingSummary>(`/gym/${gymId}/payments/summary`);

export const listGymPayments = (
  gymId: string,
  params: { q?: string; method?: string; from?: string; to?: string; limit?: number; offset?: number } = {}
) => {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.method) qs.set('method', params.method);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  return api<Payment[]>(`/gym/${gymId}/payments?${qs}`);
};

export const listGymCharges = (gymId: string, params: { status?: string; q?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.q) qs.set('q', params.q);
  return api<Charge[]>(`/gym/${gymId}/charges?${qs}`);
};

export const getMemberBilling = (gymId: string, memberId: string) =>
  api<{ charges: Charge[]; payments: Payment[] }>(`/gym/${gymId}/members/${memberId}/payments`);

export const createCharge = (
  gymId: string, memberId: string,
  body: { description: string; amount_cents: number; due_on?: string; period_start?: string; period_end?: string }
) => api<Charge>(`/gym/${gymId}/members/${memberId}/charges`, { method: 'POST', body });

export const recordPayment = (
  gymId: string, memberId: string,
  body: { charge_id: string; amount_cents: number; method: string; paid_on?: string; note?: string; allow_duplicate?: boolean }
) => api<Payment>(`/gym/${gymId}/members/${memberId}/payments`, { method: 'POST', body });

export const refundPayment = (
  gymId: string, memberId: string, paymentId: string,
  body: { amount_cents: number; reason?: string }
) => api<{ refund: any; payment: Payment }>(
  `/gym/${gymId}/members/${memberId}/payments/${paymentId}/refund`, { method: 'POST', body }
);

export const getReceipt = (gymId: string, memberId: string, paymentId: string) =>
  api<Receipt>(`/gym/${gymId}/members/${memberId}/payments/${paymentId}/receipt`);

// money helpers: stored as integer minor units, displayed in major units
export function formatMoney(cents: number, currency: string): string {
  const symbols: Record<string, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };
  const symbol = symbols[currency] || `${currency} `;
  return `${symbol}${(cents / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

// ── payment proofs (Phase M11) ───────────────────────────────────────────

export interface PaymentProof {
  id: string;
  gym_id: string;
  member_id: string;
  charge_id: string;
  membership_id: string | null;
  amount_cents: number;
  currency: string;
  method: 'UPI' | 'CARD' | 'BANK_TRANSFER' | 'OTHER';
  transaction_id: string;
  paid_on: string;
  notes: string | null;
  status: 'PENDING_VERIFICATION' | 'APPROVED' | 'REJECTED' | 'CANCELLED_BY_MEMBER' | 'SUPERSEDED';
  status_label: string;
  rejection_reason: string | null;
  supersede_reason: string | null;
  payment_id: string | null;
  charge_description?: string;
  charge_status?: string;
  plan_name?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  first_name?: string;
  last_name?: string;
  member_code?: string;
  submitted_by_name?: string | null;
  reviewed_by_name?: string | null;
  created_at: string;
  reviewed_at?: string | null;
}

export const listGymPaymentProofs = (gymId: string, status?: string) =>
  api<PaymentProof[]>(`/gym/${gymId}/payment-proofs${status ? `?status=${encodeURIComponent(status)}` : ''}`);

export const getPendingProofTotals = (gymId: string) =>
  api<{ total: number; count: number }>(`/gym/${gymId}/payment-proofs/summary`);

// authorized screenshot fetch → blob URL (token-required endpoint)
export async function fetchProofScreenshotUrl(gymId: string, proofId: string): Promise<string | null> {
  const { API_BASE, getAccessToken } = await import('./client');
  const res = await fetch(`${API_BASE}/gym/${gymId}/payment-proofs/${proofId}/screenshot`, {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  });
  if (!res.ok) return null;
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export const approvePaymentProof = (gymId: string, proofId: string) =>
  api<{ proof: PaymentProof; payment: Payment }>(`/gym/${gymId}/payment-proofs/${proofId}/approve`,
    { method: 'POST' });

export const rejectPaymentProof = (gymId: string, proofId: string, reason: string) =>
  api<PaymentProof>(`/gym/${gymId}/payment-proofs/${proofId}/reject`,
    { method: 'POST', body: { reason } });

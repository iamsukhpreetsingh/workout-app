// Review modal: proof details + authorized screenshot + approve/reject.
import React, { useState, useEffect } from 'react';
import { Modal, Descriptions, Image, Button, Space, Typography, Popconfirm } from 'antd';
import { formatMoney, PaymentProof, fetchProofScreenshotUrl } from '../api';

interface Props {
  gymId: string;
  proof: PaymentProof | null;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
}

export default function ProofReviewModal({ gymId, proof, onClose, onApprove, onReject }: Props) {
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!proof) { setShotUrl(null); return; }
    setLoading(true);
    fetchProofScreenshotUrl(gymId, proof.id)
      .then((url) => setShotUrl(url))
      .catch(() => setShotUrl(null))
      .finally(() => setLoading(false));
  }, [gymId, proof?.id]);

  if (!proof) return null;

  return (
    <Modal
      title={`Payment Proof — ${[proof.first_name, proof.last_name].filter(Boolean).join(' ') || proof.member_code}`}
      open={!!proof}
      onCancel={onClose}
      footer={
        proof.status === 'PENDING_VERIFICATION' ? (
          <Space>
            <Popconfirm title="Reject this payment proof?" description="The original due remains outstanding."
              okButtonProps={{ danger: true }} okText="Reject Payment" onConfirm={onReject}>
              <Button danger>Reject Payment</Button>
            </Popconfirm>
            <Popconfirm title="Approve Payment?" okText="Approve Payment"
              description="This will mark the outstanding payment as PAID and generate a receipt."
              onConfirm={onApprove}>
              <Button type="primary">Approve Payment</Button>
            </Popconfirm>
          </Space>
        ) : <Button onClick={onClose}>Close</Button>
      }
    >
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label="Member">
          {[proof.first_name, proof.last_name].filter(Boolean).join(' ')} ({proof.member_code})
        </Descriptions.Item>
        <Descriptions.Item label="Amount">{formatMoney(proof.amount_cents, proof.currency)}</Descriptions.Item>
        <Descriptions.Item label="Method">{proof.method}</Descriptions.Item>
        <Descriptions.Item label="Transaction ID">{proof.transaction_id}</Descriptions.Item>
        <Descriptions.Item label="Payment date">{proof.paid_on}</Descriptions.Item>
        <Descriptions.Item label="Membership">{proof.plan_name || proof.charge_description}</Descriptions.Item>
        {proof.period_start && (
          <Descriptions.Item label="Covered period">{proof.period_start} → {proof.period_end}</Descriptions.Item>
        )}
        <Descriptions.Item label="Submitted">{String(proof.created_at).slice(0, 16).replace('T', ' ')}</Descriptions.Item>
        <Descriptions.Item label="Status">
          <Typography.Text type={proof.status === 'PENDING_VERIFICATION' ? 'warning' :
            proof.status === 'APPROVED' ? 'success' : 'danger'}>
            {proof.status_label}
          </Typography.Text>
        </Descriptions.Item>
        {proof.rejection_reason && (
          <Descriptions.Item label="Rejection reason">{proof.rejection_reason}</Descriptions.Item>
        )}
        {proof.supersede_reason && (
          <Descriptions.Item label="Superseded">{proof.supersede_reason}</Descriptions.Item>
        )}
      </Descriptions>
      {loading ? (
        <Typography.Text type="secondary">Loading screenshot…</Typography.Text>
      ) : shotUrl ? (
        <Image src={shotUrl} alt="Payment screenshot" style={{ maxHeight: 320, width: '100%', objectFit: 'contain' }} />
      ) : (
        <Typography.Text type="warning">Screenshot no longer available.</Typography.Text>
      )}
    </Modal>
  );
}

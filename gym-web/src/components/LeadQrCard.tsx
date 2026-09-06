// LeadQrCard — the gym's Lead/Visitor QR poster (mirrors CheckinPosterCard,
// but encodes the PUBLIC /join URL, not the attendance payload). The two QRs
// share nothing: separate secret (settings.lead_qr_code), separate payload
// prefix (gymlead:v1:), separate endpoint, separate page.
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Popconfirm, Space, Typography } from 'antd';
import { QRCodeCanvas } from 'qrcode.react';
import { ReloadOutlined } from '@ant-design/icons';
import { getLeadQrCode, rotateLeadQrCode } from '../api/leads';
import { useGymContext } from '../permissions';

// the exact value encoded in the QR — typed payload + the public URL that
// resolves it (hash routing)
export function leadJoinUrl(code: string): string {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#/join/${code}`;
}

export default function LeadQrCard() {
  const ctx = useGymContext();
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);

  const load = useCallback(async () => {
    if (!ctx?.gymId) return;
    setError(null);
    try {
      setCode((await getLeadQrCode(ctx.gymId)).lead_qr_code);
    } catch (e: any) {
      setError(e.message || 'Could not load the Lead QR');
    }
  }, [ctx?.gymId]);

  useEffect(() => { load(); }, [load]);

  const rotate = async () => {
    if (!ctx?.gymId || rotating) return;
    setRotating(true);
    try {
      setCode((await rotateLeadQrCode(ctx.gymId)).lead_qr_code);
    } catch (e: any) {
      setError(e.message || 'Could not rotate the QR');
    } finally {
      setRotating(false);
    }
  };

  return (
    <Card
      size="small"
      title="Lead / Visitor QR"
      extra={
        <Popconfirm
          title="Regenerate the Lead QR?"
          description="Old printed posters stop working immediately — visitors scanning them see a safe 'no longer active' message. No leads are lost."
          okText="Regenerate"
          onConfirm={rotate}
        >
          <Button size="small" icon={<ReloadOutlined />} loading={rotating}>Regenerate</Button>
        </Popconfirm>
      }
    >
      {error ? (
        <Alert type="error" message={error} />
      ) : !code ? (
        <Typography.Text type="secondary">Loading…</Typography.Text>
      ) : (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'center', padding: 8, background: '#fff', borderRadius: 8 }}>
            {/* rendered locally — the URL contains the QR secret, never sent
                to any external QR service */}
            <QRCodeCanvas value={leadJoinUrl(code)} size={168} includeMargin={false} />
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Print this poster and display it at the gym. Visitors scan it and fill a short
            form — no app, no account. Their enquiry appears in your Leads list.
          </Typography.Text>
          <Typography.Paragraph code copyable style={{ fontSize: 11, margin: 0, wordBreak: 'break-all' }}>
            {leadJoinUrl(code)}
          </Typography.Paragraph>
        </Space>
      )}
    </Card>
  );
}

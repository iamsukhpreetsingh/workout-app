// Door poster card (Mobile M6 follow-up) — the SCANNABLE QR members hit at
// the door. The poster encodes the gym's 128-bit check-in secret
// (gymcheckin:v1:<code>) — never the gym id, which would be guessable. The
// QR is rendered locally by qrcode.react; the payload is a secret, so it is
// never sent to any external image/QR service. Printing re-renders the same
// payload from a hidden high-res canvas into a standalone poster window.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Popconfirm, Spin, Typography, App as AntApp, Alert } from 'antd';
import { QrcodeOutlined, PrinterOutlined, SyncOutlined } from '@ant-design/icons';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import { useGymContext } from '../permissions';
import {
  getCheckinCode, rotateCheckinCode, checkinPosterPayload,
} from '../api';

export default function CheckinPosterCard() {
  const ctx = useGymContext();
  const gymId = ctx?.gymId;
  const gymName = ctx?.gymName || 'Your gym';
  const { message } = AntApp.useApp();

  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<any>(null);
  const [rotating, setRotating] = useState(false);
  const printCanvas = useRef<HTMLCanvasElement>(null);

  const load = useCallback(async () => {
    if (!gymId) return;
    setError(null);
    try {
      const r = await getCheckinCode(gymId);
      setCode(r.checkin_code);
    } catch (e: any) {
      setError(e);
    }
  }, [gymId]);

  useEffect(() => { load(); }, [load]);

  const rotate = async () => {
    if (!gymId) return;
    setRotating(true);
    try {
      const r = await rotateCheckinCode(gymId);
      setCode(r.checkin_code);
      message.success('New code issued — every printed poster is now invalid. Reprint this one.');
    } catch (e: any) {
      message.error(e.message || 'Could not rotate the code');
    } finally {
      setRotating(false);
    }
  };

  const printPoster = () => {
    const canvas = printCanvas.current;
    if (!canvas) return;
    const win = window.open('', '_blank', 'width=720,height=920');
    if (!win) {
      message.error('Allow pop-ups for this site to print the poster');
      return;
    }
    const qr = canvas.toDataURL('image/png');
    const today = new Date().toISOString().slice(0, 10);
    win.document.write(`<!doctype html>
<html><head><title>Check-in poster — ${gymName}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; margin: 0; background: #fff; }
  .sheet { max-width: 620px; margin: 0 auto; padding: 48px 40px; text-align: center; color: #1C1917; }
  .gym { font-size: 22px; letter-spacing: 4px; text-transform: uppercase; color: #E8481F; font-weight: bold; }
  h1 { font-size: 40px; margin: 18px 0 6px; }
  .sub { font-size: 16px; color: #57534E; margin-bottom: 28px; }
  img { width: 440px; height: 440px; }
  .code { font-family: 'Courier New', monospace; font-size: 15px; letter-spacing: 1px;
          background: #F5F5F4; border: 1px dashed #D6D3D1; border-radius: 6px;
          padding: 10px 18px; display: inline-block; margin-top: 26px; }
  .typed { font-size: 13px; color: #57534E; margin-top: 6px; }
  .foot { margin-top: 34px; font-size: 11px; color: #A8A29E; line-height: 1.6; }
</style></head><body>
<div class="sheet">
  <div class="gym">${gymName.replace(/[<>&]/g, '')}</div>
  <h1>Scan to check in</h1>
  <div class="sub">Open the app &rarr; My Gym &rarr; Check in with QR</div>
  <img src="${qr}" alt="Check-in QR code" />
  <div class="code">${code}</div>
  <div class="typed">No camera? Type the code above in the app's check-in screen.</div>
  <div class="foot">
    One visit is recorded per day, verified against your membership by the gym.<br />
    This poster carries the gym's check-in code — keep it inside the premises.
    If copies leave your control, reprint from Attendance &rarr; Door poster after rotating the code.<br />
    Issued ${today}
  </div>
</div>
<script>window.onload = function () { window.focus(); window.print(); };</script>
</body></html>`);
    win.document.close();
  };

  return (
    <Card
      size="small"
      title={<><QrcodeOutlined /> Door poster</>}
      extra={
        code && (
          <Popconfirm
            title="Re-issue the check-in code?"
            description="Every printed poster and shared copy stops working immediately."
            okText="Rotate"
            onConfirm={rotate}
          >
            <Button size="small" icon={<SyncOutlined />} loading={rotating}>Rotate</Button>
          </Popconfirm>
        )
      }
    >
      {error ? (
        <Alert
          type="error" showIcon message="Could not load the check-in code"
          description={error.message}
          action={<Button size="small" onClick={load}>Retry</Button>}
        />
      ) : !code ? (
        <div style={{ padding: '28px 0', textAlign: 'center' }}><Spin /></div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{
              padding: 10, background: '#fff', border: '1px solid #E7E5E4',
              borderRadius: 8, lineHeight: 0,
            }}>
              <QRCodeSVG value={checkinPosterPayload(code)} size={148} level="M" marginSize={0} />
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <Typography.Text strong style={{ fontSize: 15 }}>Scan at the door</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 12 }}>
                Members open <b>My Gym → Check in</b> and scan this — the app records today's
                visit (once per day, membership verified by the backend).
              </Typography.Paragraph>
              <Typography.Text type="secondary" copyable style={{ fontSize: 11, fontFamily: 'monospace' }}>
                {code}
              </Typography.Text>
            </div>
          </div>
          <Button
            block style={{ marginTop: 12 }} icon={<PrinterOutlined />} onClick={printPoster}
          >
            Print the poster
          </Button>
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 11 }}>
            The code is a secret that identifies this gym — keep the poster in-house and rotate it
            if copies escape. Rotating invalidates every printed copy.
          </Typography.Text>
          {/* high-res render used only as the print source */}
          <div style={{ position: 'absolute', left: -9999, top: 0 }} aria-hidden>
            <QRCodeCanvas ref={printCanvas} value={checkinPosterPayload(code)} size={640} level="M" marginSize={0} />
          </div>
        </>
      )}
    </Card>
  );
}

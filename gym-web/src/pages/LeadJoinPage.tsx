// LeadJoinPage — the PUBLIC page a visitor lands on after scanning the
// gym's Lead QR. Deliberately standalone: no signup, no login, no app —
// one mobile-friendly form that POSTs to the unauthenticated backend
// endpoint and shows a thank-you screen. Renders OUTSIDE the auth shell
// (App.tsx early-return, same pattern as InviteLandingPage).
import React, { useEffect, useState } from 'react';
import { App as AntApp, Button, Card, DatePicker, Form, Input, Result, Select, Spin, Typography } from 'antd';
import dayjs from 'dayjs';
import { api } from '../api/client';

interface Landing {
  state: 'OK' | 'UNAVAILABLE';
  gym_name?: string;
  city?: string | null;
  types?: string[];
}

const TYPE_OPTIONS = [
  { value: 'ENQUIRY', label: 'Membership enquiry' },
  { value: 'TRIAL', label: 'Free trial' },
  { value: 'VISITOR', label: 'Just visiting' },
  { value: 'GENERAL_ENQUIRY', label: 'General enquiry' },
];

const UNAVAILABLE = {
  title: 'Form unavailable',
  message: 'Unable to open this registration form. The QR code may be invalid or no longer active. Please contact the gym directly.',
};

export default function LeadJoinPage({ token }: { token: string }) {
  const { message } = AntApp.useApp();
  const [landing, setLanding] = useState<Landing | null>(null);
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const data = await api<Landing>(`/gym/leads/public/${encodeURIComponent(token)}`);
        if (mounted) setLanding(data);
      } catch {
        if (mounted) setLanding({ state: 'UNAVAILABLE' });
      }
    })();
    return () => { mounted = false; };
  }, [token]);

  const submit = async (values: any) => {
    if (submitting) return; // double-tap guard — the backend also dedupes
    setSubmitting(true);
    setFailed(false);
    try {
      const payload = {
        full_name: values.full_name,
        phone: values.phone,
        email: values.email || undefined,
        enquiry_type: values.enquiry_type || 'ENQUIRY',
        message: values.message || undefined,
        preferred_visit_on: values.preferred_visit_on
          ? dayjs(values.preferred_visit_on).format('YYYY-MM-DD')
          : undefined,
      };
      const res = await api<{ gym_name: string }>(`/gym/leads/public/${encodeURIComponent(token)}`, {
        method: 'POST', body: payload,
      });
      setDone(res.gym_name || 'the gym');
    } catch (e: any) {
      // never claim success when the backend did not confirm (spec 24)
      setFailed(true);
      message.error(e?.message || "We couldn't submit your details. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (landing === null) {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><Spin /></div>;
  }

  if (landing.state !== 'OK') {
    // invalid QR / disabled QR / suspended or deactivated gym — one safe
    // message for every shape, nothing internal leaks
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <Result status="warning" title={UNAVAILABLE.title} subTitle={UNAVAILABLE.message} />
      </div>
    );
  }

  if (done) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <Result
          status="success"
          title="Thank You!"
          subTitle={
            <span>
              Your details have been submitted to <b>{done}</b>.<br />
              Our team will contact you soon. You can now close this page.
            </span>
          }
        />
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16,
      background: '#f5f5f5',
    }}>
      <Card style={{ width: '100%', maxWidth: 460 }}>
        <Typography.Title level={4} style={{ marginBottom: 0 }}>{landing.gym_name}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {landing.city ? `${landing.city} · ` : ''}Interested in joining us or trying the gym?
          Fill in your details and our team will get in touch.
        </Typography.Paragraph>
        <Form form={form} layout="vertical" onFinish={submit} requiredMark>
          <Form.Item
            name="full_name" label="Full Name" rules={[
              { required: true, message: 'Please enter your name.' },
              { max: 80, message: 'Name is too long.' },
            ]}
          >
            <Input autoComplete="name" maxLength={80} />
          </Form.Item>
          <Form.Item
            name="phone" label="Mobile Number" rules={[
              { required: true, message: 'Please enter your mobile number.' },
              { pattern: /^[0-9+\-()[\]\s]{7,20}$/, message: 'Please enter a valid mobile number.' },
            ]}
          >
            <Input autoComplete="tel" inputMode="tel" maxLength={20} />
          </Form.Item>
          <Form.Item
            name="email" label="Email (optional)"
            rules={[{ type: 'email', message: 'Please enter a valid email address.' }]}
          >
            <Input autoComplete="email" maxLength={120} inputMode="email" />
          </Form.Item>
          <Form.Item name="enquiry_type" label="What are you interested in?" initialValue="ENQUIRY">
            <Select options={landing.types ? TYPE_OPTIONS.filter((t) => landing.types!.includes(t.value)) : TYPE_OPTIONS} />
          </Form.Item>
          <Form.Item name="preferred_visit_on" label="Preferred visit date (optional)">
            <DatePicker style={{ width: '100%' }} disabledDate={(d) => d && d.isBefore(dayjs().startOf('day'))} />
          </Form.Item>
          <Form.Item name="message" label="Message (optional)" rules={[{ max: 500, message: 'Message is too long.' }]}>
            <Input.TextArea rows={3} maxLength={500} showCount />
          </Form.Item>
          {failed && (
            <Typography.Paragraph type="danger">
              We couldn't submit your details. Please try again.
            </Typography.Paragraph>
          )}
          <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
            Submit
          </Button>
          <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginTop: 12, marginBottom: 0 }}>
            By submitting this form, you agree that {landing.gym_name} may use your information to
            contact you regarding your enquiry.
          </Typography.Paragraph>
        </Form>
      </Card>
    </div>
  );
}

// Create Gym wizard — the onboarding flow from the spec:
//   Gym Name → Contact Information → Address → Operating Hours → Branding
//   → Create Gym → Gym Dashboard
// Each step validates its own fields; the backend re-validates everything
// (it is the authority) and errors are surfaced on the review step.
import React, { useMemo, useState } from 'react';
import {
  Steps, Card, Form, Input, Button, Typography, ColorPicker, Alert, App as AntApp,
  Descriptions, Tag, Space, Result, Spin, Select,
} from 'antd';
import { createGym, timezoneOptions, OperatingHours, Gym } from '../api';
import OperatingHoursEditor from '../components/OperatingHoursEditor';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const STEP_FIELDS: string[][] = [
  ['name', 'timezone', 'currency'],
  ['phone', 'email', 'website'],
  ['address_line1', 'address_line2', 'city', 'state', 'postal_code'],
  [], // hours — validated via hoursComplete()
  ['branding'],
  [], // review
];

const DAY_LABELS: Record<string, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu',
  fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

function describeHours(hours: OperatingHours): string {
  if (!hours) return 'Not set';
  const parts = DAYS.map((d) => {
    const h = hours[d];
    if (!h || h.closed) return null;
    return `${DAY_LABELS[d]} ${h.open}–${h.close}`;
  }).filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Open never (all days closed)';
}

interface Props {
  onCreated: (gymId: string) => void;
}

export default function CreateGymWizard({ onCreated }: Props) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [step, setStep] = useState(0);
  const [hours, setHours] = useState<OperatingHours | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<Gym | null>(null);

  const tzOptions = useMemo(
    () => timezoneOptions().map((tz) => ({ value: tz })),
    []
  );

  const next = async () => {
    try {
      await form.validateFields(STEP_FIELDS[step]);
      if (step === 3 && !hours) {
        message.warning('Set at least your open days, then continue');
        return;
      }
      setSubmitError(null);
      setStep((s) => s + 1);
    } catch {
      // field errors are shown inline by the form
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const v = form.getFieldsValue();
      const branding = v.branding || {};
      const payload = {
        name: v.name,
        timezone: v.timezone,
        currency: v.currency,
        phone: v.phone || undefined,
        email: v.email || undefined,
        website: v.website || undefined,
        address_line1: v.address_line1 || undefined,
        address_line2: v.address_line2 || undefined,
        city: v.city || undefined,
        state: v.state || undefined,
        postal_code: v.postal_code || undefined,
        operating_hours: hours || undefined,
        branding: {
          ...(branding.primary_color
            ? { primary_color: typeof branding.primary_color === 'string'
                ? branding.primary_color : branding.primary_color.toHexString() }
            : {}),
          ...(branding.secondary_color
            ? { secondary_color: typeof branding.secondary_color === 'string'
                ? branding.secondary_color : branding.secondary_color.toHexString() }
            : {}),
        },
      };
      const result = await createGym(payload);
      setCreated(result.gym);
      message.success(`${result.gym.name} is ready — welcome!`);
      setTimeout(() => onCreated(result.gym.id), 800);
    } catch (e: any) {
      setSubmitError(e.message || 'Gym creation failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (created) {
    return (
      <Result
        status="success"
        title={`${created.name} created`}
        subTitle="You are the gym's OWNER. Taking you to the dashboard…"
      />
    );
  }

  const v = form.getFieldsValue(true);
  const branding = v.branding || {};

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <Typography.Title level={3}>Create your gym</Typography.Title>
      <Typography.Paragraph type="secondary">
        You become this gym's OWNER. Your role is scoped to this gym only — your personal
        workouts, diet and progress in the mobile app are not touched.
      </Typography.Paragraph>

      <Steps
        current={step}
        items={['Name', 'Contact', 'Address', 'Hours', 'Branding', 'Review'].map((t) => ({ title: t }))}
        style={{ marginBottom: 24 }}
        size="small"
      />

      <Card>
        <Form form={form} layout="vertical" initialValues={{ timezone: 'Asia/Kolkata', currency: 'INR' }}>
          <div style={{ display: step === 0 ? 'block' : 'none' }}>
            <Form.Item
              name="name"
              label="Gym name"
              rules={[
                { required: true, message: 'Gym name is required' },
                { max: 120, message: 'Max 120 characters' },
              ]}
            >
              <Input placeholder="ABC Fitness" />
            </Form.Item>
            <Form.Item name="timezone" label="Timezone" rules={[{ required: true, message: 'Timezone is required' }]}>
              <Select showSearch optionFilterProp="value" options={tzOptions} placeholder="Select your timezone" />
            </Form.Item>
            <Form.Item
              name="currency"
              label="Currency"
              rules={[{ required: true }, { pattern: /^[A-Z]{3}$/, message: '3-letter code, e.g. INR' }]}
            >
              <Input placeholder="INR" maxLength={3} />
            </Form.Item>
          </div>

          <div style={{ display: step === 1 ? 'block' : 'none' }}>
            <Typography.Paragraph type="secondary">
              All optional — but a complete profile helps members reach you.
            </Typography.Paragraph>
            <Form.Item name="phone" label="Phone" rules={[{ pattern: /^[+()\-.\s0-9]{6,20}$/, message: 'Invalid phone number' }]}>
              <Input placeholder="+91 98765 43210" />
            </Form.Item>
            <Form.Item name="email" label="Email" rules={[{ type: 'email', message: 'Invalid email address' }]}>
              <Input placeholder="hello@abcfitness.com" />
            </Form.Item>
            <Form.Item name="website" label="Website" rules={[{ type: 'url', message: 'Enter a full http(s) URL' }]}>
              <Input placeholder="https://abcfitness.com" />
            </Form.Item>
          </div>

          <div style={{ display: step === 2 ? 'block' : 'none' }}>
            <Form.Item name="address_line1" label="Address line 1">
              <Input placeholder="Sector 17" />
            </Form.Item>
            <Form.Item name="address_line2" label="Address line 2">
              <Input placeholder="Landmark / area (optional)" />
            </Form.Item>
            <Space wrap>
              <Form.Item name="city" label="City" style={{ minWidth: 180 }}>
                <Input placeholder="Chandigarh" />
              </Form.Item>
              <Form.Item name="state" label="State" style={{ minWidth: 180 }}>
                <Input placeholder="Punjab" />
              </Form.Item>
              <Form.Item name="postal_code" label="Postal code" style={{ minWidth: 140 }}>
                <Input placeholder="160017" />
              </Form.Item>
            </Space>
          </div>

          <div style={{ display: step === 3 ? 'block' : 'none' }}>
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
              Toggle each day open and set the times. Closed days are shown to members as closed.
            </Typography.Paragraph>
            <OperatingHoursEditor value={hours} onChange={setHours} />
          </div>

          <div style={{ display: step === 4 ? 'block' : 'none' }}>
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
              Colors used across your gym portal and member-facing surfaces.
            </Typography.Paragraph>
            <Space size="large" wrap>
              <Form.Item name={['branding', 'primary_color']} label="Primary color">
                <ColorPicker showText disabledAlpha format="hex" presets={[{ label: 'Brand', colors: ['#E8481F', '#5856D6', '#16A34A', '#D97706'] }]} />
              </Form.Item>
              <Form.Item name={['branding', 'secondary_color']} label="Secondary color">
                <ColorPicker showText disabledAlpha format="hex" />
              </Form.Item>
            </Space>
          </div>

          <div style={{ display: step === 5 ? 'block' : 'none' }}>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="Name">{v.name || '—'}</Descriptions.Item>
              <Descriptions.Item label="Timezone">{v.timezone || '—'}</Descriptions.Item>
              <Descriptions.Item label="Currency">{v.currency || '—'}</Descriptions.Item>
              <Descriptions.Item label="Contact">
                {[v.phone, v.email, v.website].filter(Boolean).join(' · ') || 'Not provided'}
              </Descriptions.Item>
              <Descriptions.Item label="Address">
                {[v.address_line1, v.address_line2, v.city, v.state, v.postal_code].filter(Boolean).join(', ') || 'Not provided'}
              </Descriptions.Item>
              <Descriptions.Item label="Hours">{describeHours(hours || {})}</Descriptions.Item>
              <Descriptions.Item label="Branding">
                <Space>
                  {branding.primary_color && <Tag color={typeof branding.primary_color === 'string' ? branding.primary_color : branding.primary_color.toHexString()}>Primary</Tag>}
                  {branding.secondary_color && <Tag color={typeof branding.secondary_color === 'string' ? branding.secondary_color : branding.secondary_color.toHexString()}>Secondary</Tag>}
                  {!branding.primary_color && !branding.secondary_color && 'Default'}
                </Space>
              </Descriptions.Item>
            </Descriptions>
            {submitError && (
              <Alert
                type="error"
                showIcon
                message="Gym creation failed"
                description={submitError}
                style={{ marginTop: 16 }}
              />
            )}
          </div>
        </Form>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
          <Button disabled={step === 0 || submitting} onClick={() => setStep((s) => s - 1)}>
            Back
          </Button>
          {step < 5 ? (
            <Button type="primary" onClick={next}>Continue</Button>
          ) : (
            <Button type="primary" loading={submitting} onClick={submit}>
              Create gym
            </Button>
          )}
        </div>
      </Card>

      {submitting && (
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Spin /> <span style={{ marginLeft: 8, color: 'rgba(255,255,255,0.6)' }}>Creating your gym…</span>
        </div>
      )}
    </div>
  );
}

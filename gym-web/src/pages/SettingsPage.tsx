// Settings — the spec's tree:
//   Settings
//     ├── Gym Profile      (name, timezone, currency, logo, status/lifecycle)
//     ├── Branding         (primary/secondary colors)
//     ├── Operating Hours  (7-day editor)
//     └── Contact Information (phone, email, website, address)
// Every tab saves through PATCH /gym/:gymId; the backend re-validates and
// its error is shown verbatim. settings.manage is OWNER-only server-side —
// non-owner staff simply get 403s surfaced as messages.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Tabs, Form, Input, Button, Select, Upload, Avatar, ColorPicker, Alert,
  App as AntApp, Popconfirm, Space, Typography, Divider, Skeleton, Tag,
} from 'antd';
import { UploadOutlined, DeleteOutlined, PauseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Gym, getGym, updateGym, uploadGymLogo, removeGymLogo, fetchGymLogoBlobUrl,
  deactivateGym, reactivateGym, timezoneOptions,
} from '../api';
import OperatingHoursEditor from '../components/OperatingHoursEditor';

const VALID_TABS = ['profile', 'branding', 'hours', 'contact'];

interface Props {
  gymId: string;
  myRole: string | null;
}

export default function SettingsPage({ gymId, myRole }: Props) {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const params = useParams();
  const tab = params.tab && VALID_TABS.includes(params.tab) ? params.tab : 'profile';

  const [gym, setGym] = useState<Gym | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [hours, setHours] = useState<Gym['operating_hours']>({});

  const [profileForm] = Form.useForm();
  const [contactForm] = Form.useForm();
  const [brandingForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const g = await getGym(gymId);
      setGym(g);
      setHours(g.operating_hours || {});
      profileForm.setFieldsValue({
        name: g.name, timezone: g.timezone, currency: g.currency,
      });
      contactForm.setFieldsValue({
        phone: g.phone || undefined, email: g.email || undefined,
        website: g.website || undefined,
        address_line1: g.address_line1 || undefined, address_line2: g.address_line2 || undefined,
        city: g.city || undefined, state: g.state || undefined,
        postal_code: g.postal_code || undefined,
      });
      brandingForm.setFieldsValue({
        branding: {
          primary_color: g.branding?.primary_color || undefined,
          secondary_color: g.branding?.secondary_color || undefined,
        },
      });
      setLogoUrl(await fetchGymLogoBlobUrl(gymId));
    } catch (e: any) {
      setError(e.message || 'Could not load gym settings');
    } finally {
      setLoading(false);
    }
  }, [gymId, profileForm, contactForm, brandingForm]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 24 }}><Skeleton active paragraph={{ rows: 8 }} /></div>;
  if (error || !gym) {
    return (
      <div style={{ padding: 24 }}>
        <Alert type="error" showIcon message="Could not load gym settings" description={error}
          action={<Button onClick={load}>Retry</Button>} />
      </div>
    );
  }

  const save = async (patch: Record<string, any>, okText = 'Saved') => {
    setSaving(true);
    try {
      const updated = await updateGym(gymId, patch);
      setGym((prev) => ({ ...(prev as Gym), ...updated }));
      message.success(okText);
      return true;
    } catch (e: any) {
      message.error(e.message || 'Save failed');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const isOwner = myRole === 'OWNER';

  // ── tab: Gym Profile ────────────────────────────────────────────────
  const profileTab = (
    <>
      <Form form={profileForm} layout="vertical" onFinish={(v) => save(v, 'Gym profile saved')}>
        <Space align="center" style={{ marginBottom: 16 }}>
          {logoUrl
            ? <Avatar shape="square" size={64} src={logoUrl} />
            : <Avatar shape="square" size={64} style={{ background: gym.branding?.primary_color || '#E8481F', fontSize: 28, fontWeight: 700 }}>
                {gym.name.charAt(0).toUpperCase()}
              </Avatar>}
          <Upload
            accept="image/png,image/jpeg,image/webp"
            showUploadList={false}
            beforeUpload={async (file) => {
              if (file.size > 2 * 1024 * 1024) {
                message.error('Logo must be 2MB or smaller');
                return Upload.LIST_IGNORE;
              }
              try {
                await uploadGymLogo(gymId, file);
                message.success('Logo updated');
                setLogoUrl(await fetchGymLogoBlobUrl(gymId));
              } catch (e: any) {
                message.error(e.message || 'Logo upload failed');
              }
              return Upload.LIST_IGNORE;
            }}
          >
            <Button icon={<UploadOutlined />}>Upload logo</Button>
          </Upload>
          {gym.logo_key && (
            <Button
              icon={<DeleteOutlined />}
              onClick={async () => {
                try {
                  await removeGymLogo(gymId);
                  setLogoUrl(null);
                  message.success('Logo removed');
                } catch (e: any) {
                  message.error(e.message || 'Could not remove logo');
                }
              }}
            >
              Remove
            </Button>
          )}
        </Space>

        <Form.Item name="name" label="Gym name" rules={[{ required: true, message: 'Gym name is required' }]}>
          <Input />
        </Form.Item>
        <Space wrap>
          <Form.Item name="timezone" label="Timezone" rules={[{ required: true }]}>
            <Select
              showSearch
              style={{ minWidth: 280 }}
              optionFilterProp="value"
              options={timezoneOptions().map((tz) => ({ value: tz }))}
            />
          </Form.Item>
          <Form.Item name="currency" label="Currency"
            rules={[{ required: true }, { pattern: /^[A-Z]{3}$/, message: '3-letter code' }]}>
            <Input maxLength={3} style={{ width: 100 }} />
          </Form.Item>
        </Space>
        <div>
          <Button type="primary" htmlType="submit" loading={saving}>Save profile</Button>
        </div>
      </Form>

      <Divider />
      <Typography.Title level={5}>Gym status</Typography.Title>
      <Space align="center">
        {gym.status === 'ACTIVE' && <Tag color="green">Active</Tag>}
        {gym.status === 'INACTIVE' && <Tag color="orange">Deactivated</Tag>}
        {gym.status === 'SUSPENDED' && <Tag color="red">Suspended by platform</Tag>}
        {isOwner && gym.status === 'ACTIVE' && (
          <Popconfirm
            title="Deactivate this gym?"
            description="Staff and members lose access until you reactivate it."
            okButtonProps={{ danger: true }}
            onConfirm={async () => {
              try {
                const updated = await deactivateGym(gymId);
                setGym((prev) => ({ ...(prev as Gym), ...updated }));
                message.info('Gym deactivated');
              } catch (e: any) {
                message.error(e.message || 'Could not deactivate');
              }
            }}
          >
            <Button danger icon={<PauseCircleOutlined />}>Deactivate</Button>
          </Popconfirm>
        )}
        {isOwner && gym.status === 'INACTIVE' && (
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={async () => {
              try {
                await reactivateGym(gymId);
                message.success('Gym reactivated');
                await load();
              } catch (e: any) {
                message.error(e.message || 'Could not reactivate');
              }
            }}
          >
            Reactivate
          </Button>
        )}
      </Space>
    </>
  );

  // ── tab: Branding ───────────────────────────────────────────────────
  const brandingTab = (
    <Form
      form={brandingForm}
      layout="vertical"
      onFinish={(v) => {
        const b = v.branding || {};
        const toHex = (c: any) => (typeof c === 'string' ? c : c?.toHexString?.());
        return save({
          branding: {
            ...(toHex(b.primary_color) ? { primary_color: toHex(b.primary_color) } : {}),
            ...(toHex(b.secondary_color) ? { secondary_color: toHex(b.secondary_color) } : {}),
          },
        }, 'Branding saved');
      }}
    >
      <Typography.Paragraph type="secondary">
        Colors used across the portal. Leave a color unset to keep the default.
      </Typography.Paragraph>
      <Space size="large">
        <Form.Item name={['branding', 'primary_color']} label="Primary color">
          <ColorPicker showText disabledAlpha format="hex" />
        </Form.Item>
        <Form.Item name={['branding', 'secondary_color']} label="Secondary color">
          <ColorPicker showText disabledAlpha format="hex" />
        </Form.Item>
      </Space>
      <div>
        <Button type="primary" htmlType="submit" loading={saving}>Save branding</Button>
      </div>
    </Form>
  );

  // ── tab: Operating Hours ────────────────────────────────────────────
  const hoursTab = (
    <>
      <Typography.Paragraph type="secondary">
        Toggle each day open and set the times. Closed days are shown to members as closed.
      </Typography.Paragraph>
      <OperatingHoursEditor value={hours} onChange={setHours} />
      <div style={{ marginTop: 16 }}>
        <Button
          type="primary"
          loading={saving}
          onClick={() => save({ operating_hours: hours }, 'Operating hours saved')}
        >
          Save hours
        </Button>
      </div>
    </>
  );

  // ── tab: Contact Information ────────────────────────────────────────
  const contactTab = (
    <Form form={contactForm} layout="vertical" onFinish={(v) => save(v, 'Contact information saved')}>
      <Space wrap>
        <Form.Item name="phone" label="Phone" rules={[{ pattern: /^[+()\-.\s0-9]{6,20}$/, message: 'Invalid phone number' }]}>
          <Input placeholder="+91 98765 43210" style={{ minWidth: 220 }} />
        </Form.Item>
        <Form.Item name="email" label="Email" rules={[{ type: 'email', message: 'Invalid email address' }]}>
          <Input placeholder="hello@abcfitness.com" style={{ minWidth: 220 }} />
        </Form.Item>
      </Space>
      <Form.Item name="website" label="Website" rules={[{ type: 'url', message: 'Enter a full http(s) URL' }]}>
        <Input placeholder="https://abcfitness.com" style={{ maxWidth: 460 }} />
      </Form.Item>
      <Divider style={{ margin: '8px 0 16px' }}>Address</Divider>
      <Form.Item name="address_line1" label="Address line 1">
        <Input style={{ maxWidth: 460 }} />
      </Form.Item>
      <Form.Item name="address_line2" label="Address line 2">
        <Input style={{ maxWidth: 460 }} />
      </Form.Item>
      <Space wrap>
        <Form.Item name="city" label="City"><Input style={{ minWidth: 160 }} /></Form.Item>
        <Form.Item name="state" label="State"><Input style={{ minWidth: 160 }} /></Form.Item>
        <Form.Item name="postal_code" label="Postal code"><Input style={{ width: 140 }} /></Form.Item>
      </Space>
      <div>
        <Button type="primary" htmlType="submit" loading={saving}>Save contact information</Button>
      </div>
    </Form>
  );

  return (
    <div style={{ padding: 24, maxWidth: 860, margin: '0 auto' }}>
      <Typography.Title level={3}>Settings</Typography.Title>
      <Tabs
        activeKey={tab}
        onChange={(k) => navigate(`/settings/${k}`)}
        items={[
          { key: 'profile', label: 'Gym Profile', children: profileTab },
          { key: 'branding', label: 'Branding', children: brandingTab },
          { key: 'hours', label: 'Operating Hours', children: hoursTab },
          { key: 'contact', label: 'Contact Information', children: contactTab },
        ]}
      />
    </div>
  );
}

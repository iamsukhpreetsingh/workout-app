// Platform-wide trainer view. Deliberately keeps the TWO relationship
// models separate and labeled — gym-assigned (gym_staff TRAINER +
// gym_trainer_assignments) vs user-connected (trainer_clients) — so the
// app's active-trainer precedence (gym assignment first) stays legible.
import React, { useEffect, useState } from 'react';
import { Alert, Card, Table, Tag, Typography } from 'antd';
import { api } from '../api';

interface GymTrainer {
  id: string; status: string; created_at: string; name: string; email: string;
  gym_name: string; gym_id: string; active_assignments: number;
}
interface Connection {
  id: string; status: string; created_at: string; responded_at: string | null;
  trainer_name: string; trainer_email: string; client_name: string; client_email: string;
}
const CONN_COLOR: Record<string, string> = { active: 'green', pending: 'gold', revoked: 'red' };

export default function AdminTrainersPage() {
  const [data, setData] = useState<{ gymTrainers: GymTrainer[]; connections: Connection[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api('/trainers').then(setData).catch((e) => setError(e.message || 'Unable to load trainers. Try again.'));
  }, []);

  if (error) return <Alert type="error" message={error} />;
  if (!data) return <Typography.Text type="secondary">Loading…</Typography.Text>;

  return (
    <div>
      <Card size="small" title={`Gym-assigned trainers (${data.gymTrainers.length})`} style={{ marginBottom: 16 }}>
        <Table
          rowKey="id" size="small" pagination={{ pageSize: 15 }}
          dataSource={data.gymTrainers}
          locale={{ emptyText: 'No gym trainers yet.' }}
          columns={[
            { title: 'Trainer', dataIndex: 'name' },
            { title: 'Email', dataIndex: 'email' },
            { title: 'Gym', dataIndex: 'gym_name' },
            { title: 'Active assignments', dataIndex: 'active_assignments', width: 150 },
            { title: 'Staff status', dataIndex: 'status', width: 110,
              render: (s: string) => <Tag color={s === 'ACTIVE' ? 'green' : 'orange'}>{s}</Tag> },
            { title: 'Since', dataIndex: 'created_at', width: 120,
              render: (v: string) => new Date(v).toLocaleDateString() },
          ]}
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
          Gym assignments take precedence over user-connected trainers in the app — this view
          never modifies assignments (that is a Gym Portal operation).
        </Typography.Paragraph>
      </Card>

      <Card size="small" title={`User-connected trainers (${data.connections.length})`}>
        <Table
          rowKey="id" size="small" pagination={{ pageSize: 15 }}
          dataSource={data.connections}
          locale={{ emptyText: 'No independent trainer connections yet.' }}
          columns={[
            { title: 'Trainer', dataIndex: 'trainer_name', render: (v: string, r: Connection) => (
              <>{v}<Typography.Text type="secondary" style={{ fontSize: 11, display: 'block' }}>{r.trainer_email}</Typography.Text></>
            ) },
            { title: 'Client', dataIndex: 'client_name', render: (v: string, r: Connection) => (
              <>{v}<Typography.Text type="secondary" style={{ fontSize: 11, display: 'block' }}>{r.client_email}</Typography.Text></>
            ) },
            { title: 'Status', dataIndex: 'status', width: 110,
              render: (s: string) => <Tag color={CONN_COLOR[s]}>{s}</Tag> },
            { title: 'Connected', dataIndex: 'created_at', width: 120,
              render: (v: string) => new Date(v).toLocaleDateString() },
          ]}
        />
      </Card>
    </div>
  );
}

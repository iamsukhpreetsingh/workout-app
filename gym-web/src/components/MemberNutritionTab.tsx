// Member's Nutrition tab — gym nutrition assigned to this member (works
// with or without an app account). Mirrors the Workouts tab.
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Table, Tag, Modal, Select, Typography, App as AntApp, Empty, Popconfirm, Space } from 'antd';
import { PlusOutlined, StopOutlined } from '@ant-design/icons';
import StatusBadge from './StatusBadge';
import { ErrorState } from './States';
import { useGymContext, hasPermission } from '../permissions';
import {
  listMemberNutritionAssignments, listAssignableNutrition, assignNutrition, endNutritionAssignment,
  NutritionAssignment, NutritionItem,
} from '../api';

export default function MemberNutritionTab({ memberId }: { memberId: string }) {
  const ctx = useGymContext();
  const { message } = AntApp.useApp();
  const [assignments, setAssignments] = useState<NutritionAssignment[] | null>(null);
  const [items, setItems] = useState<NutritionItem[]>([]);
  const [error, setError] = useState<any>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [picked, setPicked] = useState<string | undefined>();
  const canManage = hasPermission(ctx, 'members.manage');

  const load = useCallback(async () => {
    setError(null);
    try {
      const a = await listMemberNutritionAssignments(ctx!.gymId, memberId);
      setAssignments(a);
      if (canManage) setItems(await listAssignableNutrition(ctx!.gymId));
    } catch (e: any) {
      setError(e);
    }
  }, [ctx?.gymId, memberId, canManage]);

  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!assignments) return <Typography.Text type="secondary">Loading…</Typography.Text>;

  const doAssign = async () => {
    if (!picked) { message.warning('Pick an item'); return; }
    try {
      await assignNutrition(ctx!.gymId, memberId, picked);
      message.success('Assigned');
      setAssignOpen(false);
      setPicked(undefined);
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not assign');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" title="Assigned gym nutrition">
        {assignments.length === 0 ? (
          <Empty description={<Typography.Text type="secondary">
            {canManage ? 'Nothing assigned yet — pick a published item.' : 'No gym nutrition assigned.'}
          </Typography.Text>}>
            {canManage && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setAssignOpen(true)}>
                Assign nutrition
              </Button>
            )}
          </Empty>
        ) : (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={assignments}
            columns={[
              { title: 'Item', key: 'item', render: (_: any, a: NutritionAssignment) => (
                <Space size={6}>
                  <Tag color={a.item_kind === 'RECIPE' ? 'orange' : a.item_kind === 'MEAL_PLAN' ? 'blue' : 'purple'}>
                    {a.item_kind.replace(/_/g, ' ')}
                  </Tag>
                  <Typography.Text strong>{a.item_title}</Typography.Text>
                </Space>
              ) },
              { title: 'Version', dataIndex: 'item_version', width: 80, render: (v: number) => <Tag>v{v}</Tag> },
              { title: 'Assigned', dataIndex: 'created_at', width: 120, render: (v: string) => String(v).slice(0, 10) },
              { title: 'Status', key: 'status', width: 170, render: (_: any, a: NutritionAssignment) => (
                <Space>
                  <StatusBadge status={a.status === 'ACTIVE' ? 'ACTIVE' : 'EXPIRED'} />
                  {a.end_reason && <Tag>{a.end_reason.replace(/_/g, ' ')}</Tag>}
                </Space>
              ) },
              ...(canManage ? [{
                title: '', key: 'go', width: 110, render: (_: any, a: NutritionAssignment) =>
                  a.status === 'ACTIVE' ? (
                    <Popconfirm title="End this assignment?" okButtonProps={{ danger: true }}
                      onConfirm={async () => {
                        try {
                          await endNutritionAssignment(ctx!.gymId, memberId, a.id);
                          message.success('Assignment ended');
                          load();
                        } catch (e: any) { message.error(e.message || 'Could not end'); }
                      }}>
                      <Button size="small" danger icon={<StopOutlined />}>End</Button>
                    </Popconfirm>
                  ) : null,
              }] : []),
            ]}
          />
        )}
        {canManage && assignments.length > 0 && (
          <Button icon={<PlusOutlined />} style={{ marginTop: 12 }} onClick={() => setAssignOpen(true)}>
            Assign another item
          </Button>
        )}
      </Card>

      <Modal title="Assign nutrition" open={assignOpen} onOk={doAssign} onCancel={() => setAssignOpen(false)} okText="Assign">
        <Select
          style={{ width: '100%' }}
          placeholder="Select a published item"
          value={picked}
          onChange={setPicked}
          options={items.map((n) => ({
            value: n.id,
            label: `${n.kind.replace(/_/g, ' ')} — ${n.title}`,
          }))}
        />
        {items.length === 0 && (
          <Typography.Text type="secondary">No published items — create one first.</Typography.Text>
        )}
      </Modal>
    </div>
  );
}

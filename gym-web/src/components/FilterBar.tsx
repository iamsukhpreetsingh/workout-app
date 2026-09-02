// FilterBar — search input (debounced by usePagedList) + optional status
// filter select, laid out consistently across list pages.
import React from 'react';
import { Input, Select, Space } from 'antd';
import { SearchOutlined } from '@ant-design/icons';

interface Props {
  searchPlaceholder?: string;
  q: string;
  onQ: (v: string) => void;
  status?: string;
  onStatus?: (v: string | undefined) => void;
  statusOptions?: { value: string; label: string }[];
  extra?: React.ReactNode;
}

export default function FilterBar({
  searchPlaceholder = 'Search…', q, onQ, status, onStatus, statusOptions, extra,
}: Props) {
  return (
    <Space wrap size={[12, 12]} style={{ width: '100%', justifyContent: 'space-between' }}>
      <Space wrap size={[12, 12]}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder={searchPlaceholder}
          value={q}
          onChange={(e) => onQ(e.target.value)}
          style={{ width: 260 }}
        />
        {statusOptions && onStatus && (
          <Select
            allowClear
            placeholder="Status"
            style={{ minWidth: 140 }}
            value={status}
            onChange={(v) => onStatus(v)}
            options={statusOptions}
          />
        )}
      </Space>
      {extra}
    </Space>
  );
}

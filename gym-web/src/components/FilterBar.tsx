// FilterBar — search input (debounced by usePagedList) + up to two filter
// selects, laid out consistently across list pages.
import React from 'react';
import { Input, Select, Space } from 'antd';
import { SearchOutlined } from '@ant-design/icons';

interface SelectFilter {
  placeholder: string;
  value?: string;
  onChange: (v: string | undefined) => void;
  options: { value: string; label: string }[];
}

interface Props {
  searchPlaceholder?: string;
  q: string;
  onQ: (v: string) => void;
  filter?: SelectFilter;
  secondFilter?: SelectFilter;
  extra?: React.ReactNode;
}

export default function FilterBar({
  searchPlaceholder = 'Search…', q, onQ, filter, secondFilter, extra,
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
        {filter && (
          <Select
            allowClear
            placeholder={filter.placeholder}
            style={{ minWidth: 150 }}
            value={filter.value}
            onChange={(v) => filter.onChange(v)}
            options={filter.options}
          />
        )}
        {secondFilter && (
          <Select
            allowClear
            placeholder={secondFilter.placeholder}
            style={{ minWidth: 150 }}
            value={secondFilter.value}
            onChange={(v) => secondFilter.onChange(v)}
            options={secondFilter.options}
          />
        )}
      </Space>
      {extra}
    </Space>
  );
}

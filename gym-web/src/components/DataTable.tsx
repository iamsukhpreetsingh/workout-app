// DataTable — the standard list surface: loading, error w/ retry, explicit
// empty state, and prev/next pagination (the /gym list APIs are offset-
// based without a total count, so the hook fetches pageSize+1 rows and
// DataTable renders Next only when an extra row exists).
import React from 'react';
import { Table, Button, Space, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { EmptyState, ErrorState } from './States';

interface Props<T> {
  columns: ColumnsType<T>;
  rows: T[] | null;
  rowKey: (row: T) => string;
  loading: boolean;
  error: any;
  onRetry?: () => void;
  emptyTitle: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
  // pagination
  page: number;
  pageSize: number;
  hasNext: boolean;
  onPageChange: (page: number) => void;
  // toolbar renders above the table (search, filters, primary actions)
  toolbar?: React.ReactNode;
  onRow?: (row: T) => React.HTMLAttributes<any>;
  scrollX?: number;
}

export default function DataTable<T>({
  columns, rows, rowKey, loading, error, onRetry,
  emptyTitle, emptyDescription, emptyAction,
  page, pageSize, hasNext, onPageChange,
  toolbar, onRow, scrollX = 900,
}: Props<T>) {
  return (
    <>
      {toolbar && <div style={{ marginBottom: 16 }}>{toolbar}</div>}
      {error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : !loading && rows && rows.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
      ) : (
        <>
          <Table
            rowKey={rowKey}
            columns={columns}
            dataSource={rows || []}
            loading={loading}
            pagination={false}
            scroll={{ x: scrollX }}
            onRow={onRow}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <Space>
              <Typography.Text type="secondary">Page {page + 1}</Typography.Text>
              <Button
                icon={<LeftOutlined />}
                disabled={page === 0}
                onClick={() => onPageChange(page - 1)}
              />
              <Button
                icon={<RightOutlined />}
                disabled={!hasNext}
                onClick={() => onPageChange(page + 1)}
              />
            </Space>
          </div>
        </>
      )}
    </>
  );
}

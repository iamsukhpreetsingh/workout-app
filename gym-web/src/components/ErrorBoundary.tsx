// Top-level error boundary: a render crash anywhere in the portal used to
// blank the whole app (white screen). This catches render/lifecycle errors,
// shows an honest message, and offers a reload. Network/API errors are NOT
// caught here — those surface per-page through ErrorState.
import React from 'react';
import { Button, Result, Typography } from 'antd';

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // keep it in the console for diagnosis; no telemetry backend exists yet
    console.error('Unhandled render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <Result
          status="error"
          title="Something went wrong"
          subTitle={
            <Typography.Text type="secondary">
              {this.state.error.message || 'An unexpected error occurred while rendering the page.'}
            </Typography.Text>
          }
          extra={
            <Button type="primary" onClick={() => window.location.reload()}>
              Reload the portal
            </Button>
          }
          style={{ marginTop: 96 }}
        />
      );
    }
    return this.props.children;
  }
}

// PlaceholderPage — used by every section whose backend phase hasn't
// shipped. No fake data, no dead CTAs — one honest, consistent state.
import React from 'react';
import PageContainer from '../components/PageContainer';
import { ComingSoon } from '../components/States';

export default function PlaceholderPage({ title, section, phase, description }: {
  title: string;
  section: string;
  phase: string;
  description: string;
}) {
  return (
    <PageContainer
      title={title}
      crumbs={[{ label: 'Home', to: '/' }, { label: section }]}
    >
      <ComingSoon phase={phase} title={section} description={description} />
    </PageContainer>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PageLoading } from '@/components/ui';
import { api } from '@/lib/api';

export default function Index() {
  const router = useRouter();
  useEffect(() => {
    api.auth
      .me()
      .then(() => router.replace('/tasks'))
      .catch(() => router.replace('/login'));
  }, [router]);
  return <PageLoading />;
}

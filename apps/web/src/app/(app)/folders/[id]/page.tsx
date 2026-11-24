import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FolderBrowser } from '@/components/folders/folder-browser';

export const metadata: Metadata = { title: 'Folders' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function FolderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <FolderBrowser key={id} folderId={id} />;
}

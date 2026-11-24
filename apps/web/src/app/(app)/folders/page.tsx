import type { Metadata } from 'next';
import { FolderBrowser } from '@/components/folders/folder-browser';

export const metadata: Metadata = { title: 'Folders' };

export default function FoldersPage() {
  return <FolderBrowser folderId={null} />;
}

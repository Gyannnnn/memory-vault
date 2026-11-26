'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/api';
import { trash } from '@/lib/organise';

const items = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'item' : 'items'}`;

/** Moves to Trash with an Undo in the toast, and restores. */
export function useTrash() {
  const queryClient = useQueryClient();

  const restore = useCallback(
    async (ids: string[]) => {
      try {
        const restored = await trash.restore(queryClient, ids);
        toast.success(`Restored ${items(restored)}`);
        return true;
      } catch (error) {
        toast.error('Nothing was restored', { description: errorMessage(error) });
        return false;
      }
    },
    [queryClient],
  );

  const move = useCallback(
    async (ids: string[]) => {
      try {
        const moved = await trash.move(queryClient, ids);
        toast(`Moved ${items(moved)} to Trash`, {
          description: 'Deleted for good after 30 days.',
          action: { label: 'Undo', onClick: () => void restore(ids) },
        });
        return true;
      } catch (error) {
        toast.error('Nothing was moved to Trash', { description: errorMessage(error) });
        return false;
      }
    },
    [queryClient, restore],
  );

  return { move, restore };
}

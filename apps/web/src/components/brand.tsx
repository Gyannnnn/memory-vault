import { cn } from '@/lib/utils';

/** The Memory Vault mark: a stack of two frames, drawn in the current text colour. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn('size-8', className)}>
      <rect x="1" y="1" width="30" height="30" rx="8" className="fill-primary" />
      <rect
        x="8"
        y="10"
        width="13"
        height="13"
        rx="2.5"
        className="fill-none stroke-on-primary"
        strokeWidth="2"
      />
      <path
        d="M12 7.5h9.5a3 3 0 0 1 3 3V20"
        className="fill-none stroke-on-primary"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="m10 20.5 3.2-3.6 2.3 2.4 1.6-1.7 2.4 2.9"
        className="fill-none stroke-on-primary"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <BrandMark />
      <span className="text-[15px] font-semibold tracking-tight">Memory Vault</span>
    </span>
  );
}

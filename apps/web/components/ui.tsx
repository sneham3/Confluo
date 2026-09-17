'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { X } from 'lucide-react';
import { cn, initials } from '@/lib/utils';

// ---- Button ------------------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'icon';

const variantCls: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface text-ink border-line-strong hover:border-accent',
  ghost: 'bg-transparent text-ink border-transparent hover:bg-accent-soft',
  danger: 'bg-transparent text-danger border-transparent hover:bg-danger/10',
};
const sizeCls: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-4 text-sm',
  icon: 'h-8 w-8 p-0 justify-center',
};

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; active?: boolean }
>(function Button({ className, variant = 'secondary', size = 'md', active, type = 'button', ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-2 rounded-md border font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none',
        variantCls[variant],
        sizeCls[size],
        active && 'bg-accent-soft border-accent text-accent',
        className,
      )}
      {...props}
    />
  );
});

// ---- Input ---------------------------------------------------------------------------

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-muted focus-visible:border-accent',
        className,
      )}
      {...props}
    />
  );
});

export function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[13px] text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

// ---- Avatar ----------------------------------------------------------------------------

export function Avatar({ name, color, size = 28, className, dim }: { name: string; color: string; size?: number; className?: string; dim?: boolean }) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none', className)}
      style={{ width: size, height: size, background: color, fontSize: Math.max(10, size * 0.4), opacity: dim ? 0.5 : 1 }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

// ---- Badge -----------------------------------------------------------------------------

export function Badge({ children, tone = 'neutral', className }: { children: React.ReactNode; tone?: 'neutral' | 'accent' | 'warning' | 'danger' | 'success'; className?: string }) {
  const tones = {
    neutral: 'bg-code-bg text-muted',
    accent: 'bg-accent-soft text-accent',
    warning: 'bg-warning/15 text-warning',
    danger: 'bg-danger/15 text-danger',
    success: 'bg-success/15 text-success',
  };
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide', tones[tone], className)}>{children}</span>;
}

// ---- Dialog ------------------------------------------------------------------------------

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-surface p-5 shadow-xl focus:outline-none',
            wide ? 'max-w-2xl' : 'max-w-md',
          )}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <DialogPrimitive.Title className="font-display text-xl font-semibold">{title}</DialogPrimitive.Title>
              {description ? <DialogPrimitive.Description className="mt-1 text-sm text-muted">{description}</DialogPrimitive.Description> : null}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close">
                <X size={16} />
              </Button>
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ---- Tooltip -----------------------------------------------------------------------------

export function Tip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content sideOffset={6} className="z-50 rounded-md bg-ink px-2 py-1 text-[12px] text-paper shadow">
          {label}
          <TooltipPrimitive.Arrow className="fill-ink" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

// ---- Select ------------------------------------------------------------------------------

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn('h-8 rounded-md border border-line-strong bg-surface px-2 text-[13px] text-ink focus-visible:border-accent', className)}
      {...props}
    />
  );
}

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ExperimentKind, ExperimentStatus, Explained, Structure, StructureSource } from '@/api'
import { describeValue } from '@/api'
import { cn } from '@/lib/utils'
import { inputClass, kindMeaning, sourceLabel, sourceMeaning } from './format'

/** Shared building blocks for the panels: one look, and one place that says what each label means. */

export function Card({ title, description, actions, children, className, tight }: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  tight?: boolean
}) {
  return (
    <section className={cn('fs-card', tight && 'fs-card-tight', className)}>
      {(title || actions) && (
        <header className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-2', tight ? 'mb-2.5' : 'mb-4')}>
          <div className="min-w-0">
            {title && <h2 className={cn('font-semibold tracking-tight', tight ? 'text-sm' : 'text-base')}>{title}</h2>}
            {description && <p className="mt-0.5 max-w-[75ch] text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

/** A titled part of a card, set off from what is above it by a hairline. */
export function Section({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('mt-4 border-t border-border pt-4', className)}>
      {title && <h3 className="mb-2 text-sm font-semibold">{title}</h3>}
      {children}
    </div>
  )
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'accent'

const TONE: Record<Tone, { box: string; dot: string }> = {
  neutral: { box: 'border-border bg-muted/50 text-muted-foreground', dot: 'bg-muted-foreground' },
  good: { box: 'border-good/30 bg-good/10 text-good', dot: 'bg-good' },
  warn: { box: 'border-warn/30 bg-warn/10 text-warn', dot: 'bg-warn' },
  bad: { box: 'border-bad/35 bg-bad/10 text-bad', dot: 'bg-bad' },
  info: { box: 'border-info/30 bg-info/10 text-info', dot: 'bg-info' },
  accent: { box: 'border-primary/35 bg-primary/10 text-primary', dot: 'bg-primary' },
}

/** A state in a word, with a dot of its colour. The word is always there; colour never stands alone. */
export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-px text-xs font-medium whitespace-nowrap', TONE[tone].box)}>
      <span aria-hidden className={cn('size-1.5 rounded-full', TONE[tone].dot)} />
      {children}
    </span>
  )
}

const KIND_TONE: Record<ExperimentKind, Tone> = { executed: 'accent', imported: 'info', demo: 'neutral' }

export function KindBadge({ kind }: { kind: string }) {
  return <Badge tone={KIND_TONE[kind as ExperimentKind] ?? 'neutral'} title={kindMeaning(kind)}>{kind}</Badge>
}

const STATUS_TONE: Record<ExperimentStatus, Tone> = { ok: 'good', partial: 'warn', failed: 'bad' }

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status as ExperimentStatus] ?? 'neutral'}>{status}</Badge>
}

const SOURCE_TONE: Record<StructureSource, Tone> = { predicted: 'accent', experimental: 'info', uploaded: 'neutral' }

export function SourceBadge({ source }: { source: string }) {
  return <Badge tone={SOURCE_TONE[source as StructureSource] ?? 'neutral'} title={sourceMeaning(source)}>{sourceLabel(source)}</Badge>
}

/** A headline number with its label. Counts and measurements only; never a target or an estimate. */
export function Stat({ label, value, unit, hint }: { label: ReactNode; value: ReactNode; unit?: string; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-2xl font-semibold tracking-tight">
        {value}
        {unit && <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span>}
      </dd>
      {hint && <p className="mt-1 text-xs leading-snug text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-input px-5 py-7 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mx-auto mt-1.5 max-w-[60ch] text-sm text-muted-foreground">{children}</div>}
    </div>
  )
}

export function Loading({ children }: { children: ReactNode }) {
  return <p role="status" className="text-sm text-muted-foreground">{children}</p>
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p role="alert" className="rounded-md border border-bad/35 bg-bad/10 px-3 py-2 text-sm text-foreground">{children}</p>
}

/** A caveat or definition that belongs with the numbers above it. */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-xs leading-relaxed text-muted-foreground', className)}>{children}</p>
}

/** The fixed limitation sentences that come back with every rule-based explanation. Always shown. */
export function Limitations({ items }: { items: string[] }) {
  if (items.length === 0) return null
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
      {items.map((text) => <p key={text}>{text}</p>)}
    </div>
  )
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{children}</code>
}

export function TextLink({ to, children, title }: { to: string; children: ReactNode; title?: string }) {
  return <Link to={to} title={title} className="fs-link">{children}</Link>
}

export function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1 text-sm', className)}>
      <span className="text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

/** Pick one structure from the library. The option text says what kind of structure each one is. */
export function StructureSelect({ structures, value, onChange, ariaLabel, placeholder, className, id }: {
  structures: Structure[]
  value: string
  onChange: (id: string) => void
  ariaLabel?: string
  placeholder?: string
  className?: string
  id?: string
}) {
  return (
    <select id={id} aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} className={cn(inputClass, 'w-full', className)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {structures.map((s) => (
        <option key={s.id} value={s.id}>{s.label} ({sourceLabel(s.source)})</option>
      ))}
    </select>
  )
}

/**
 * A rule-based explanation as the backend returned it: the sentences, then the exact numbers they
 * were built from, then the limitations. Nothing is reworded here.
 */
export function ExplainedText({ value, compact }: { value: Explained; compact?: boolean }) {
  const numbers = Object.entries(value.numbers_used)
  return (
    <div className="space-y-3">
      <p className={cn('max-w-[75ch] leading-relaxed', compact ? 'text-[0.8125rem]' : 'text-sm')}>{value.summary}</p>
      {numbers.length > 0 && (
        <details className="group text-sm">
          <summary className="cursor-pointer rounded text-muted-foreground select-none hover:text-foreground">Numbers this is built from</summary>
          <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-[0.8125rem]">
            {numbers.map(([key, number]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{key.replaceAll('_', ' ')}</dt>
                <dd className="break-words">{describeValue(number)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <Limitations items={value.limitations} />
    </div>
  )
}

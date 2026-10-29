import { X } from 'lucide-react'
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { cx } from './ui.tsx'

/**
 * Modal dialog på det innebygde `<dialog>`-elementet. Med `showModal()` gjør
 * nettleseren resten av siden inert, holder fokus inne i dialogen og lukker
 * den med Esc, så det trengs ingen egen fokusfelle.
 *
 * Dialogen åpnes når den monteres og lukkes når den avmonteres. Vis den med
 * `{open && <Dialog …>}`, så skjemaer i den starter blanke hver gang. Fokus
 * går til elementet med `data-autofocus` (ellers det første som kan få fokus)
 * og tilbake dit det var da dialogen ble åpnet.
 */
export function Dialog({
  title,
  description,
  children,
  onClose,
  busy = false,
  className,
}: {
  title: ReactNode
  /** Leses opp sammen med tittelen når dialogen åpnes. */
  description?: ReactNode
  children: ReactNode
  onClose: () => void
  /** Noe lagres. Dialogen kan ikke lukkes før det er ferdig. */
  busy?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  // Layout-effekt: oppryddingen (lukking og fokus tilbake) må skje med en gang dialogen
  // fjernes, ikke utsatt til neste render, ellers kan den stjele fokus fra neste dialog.
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.showModal()
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    return () => {
      // Lukkes først, ellers er resten av siden fortsatt inert og fokus kan ikke flyttes dit.
      if (dialog.open) dialog.close()
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      // Esc gir `cancel`; uten preventDefault lukker nettleseren dialogen og sender `close`.
      onCancel={(e) => busy && e.preventDefault()}
      // `close` kommer asynkront. Etter lukkingen i oppryddingen kan dialogen allerede
      // være åpnet igjen (StrictMode monterer to ganger), og da gjelder ikke hendelsen.
      onClose={() => !ref.current?.open && onClose()}
      className={cx(
        'm-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md animate-in overflow-y-auto rounded-2xl bg-white p-0 text-stone-900 shadow-2xl ring-1 ring-stone-200 backdrop:bg-stone-950/40 backdrop:backdrop-blur-[2px]',
        className,
      )}
    >
      <div className="relative p-5 sm:p-6">
        <h2 id={titleId} className="pr-8 text-lg font-semibold tracking-tight text-stone-950">
          {title}
        </h2>
        {description && (
          <div id={descriptionId} className="mt-2 space-y-2 text-sm leading-relaxed text-stone-600">
            {description}
          </div>
        )}
        <div className="mt-5">{children}</div>
        {/* Sist i DOM-en, så fokus starter i innholdet, men øverst til høyre på skjermen. */}
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label="Lukk"
          className="absolute top-4 right-4 grid size-8 place-items-center rounded-lg text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 disabled:opacity-50"
        >
          <X className="size-5" aria-hidden />
        </button>
      </div>
    </dialog>
  )
}

/** Knappene nederst: under hverandre på mobil med hovedvalget øverst, ellers til høyre. */
export function DialogActions({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{children}</div>
  )
}

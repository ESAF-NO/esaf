import { Check, Copy, MailCheck, TriangleAlert } from 'lucide-react'
import { useId, useState } from 'react'
import { longDay } from '#/lib/format.ts'
import { Button, Field, Input, Textarea } from './ui.tsx'

/** Knapp som kopierer en tekst og viser «Kopiert» en stund etterpå. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setFailed(false)
          setCopied(true)
          setTimeout(() => setCopied(false), 2500)
        } catch {
          // Nettleseren kan nekte tilgang til utklippstavlen; da må teksten merkes og kopieres selv.
          setFailed(true)
        }
      }}
    >
      {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {copied ? 'Kopiert' : failed ? 'Merk og kopier selv' : label}
    </Button>
  )
}

/**
 * En lenke som nettopp er laget: om den er sendt på e-post, og lenken og en
 * ferdig melding å sende selv, med kopieringsknapper. Er den sendt, er lenken
 * her en reserve om e-posten ikke kommer fram. Lenken lagres ikke og kan ikke
 * vises igjen.
 */
export function ShareLink({
  link,
  kind,
}: {
  link: {
    url: string
    email: string
    expiresAt: Date | string
    emailed?: boolean
    emailError?: string
  }
  kind: 'invite' | 'password_reset'
}) {
  const messageId = useId()
  const until = longDay(new Date(link.expiresAt))
  const message =
    kind === 'invite'
      ? `Hei! Her er invitasjonen din til ESAF-appen: ${link.url} Den gjelder i 7 dager (til ${until}) og kan brukes én gang.`
      : `Hei! Her er lenken for å velge nytt passord i ESAF-appen: ${link.url} Den gjelder i 7 dager (til ${until}) og kan brukes én gang.`
  const opener = kind === 'invite' ? 'kommer inn som' : 'kan velge passord for'
  return (
    <div className="space-y-4">
      {link.emailed ? (
        <p
          role="status"
          className="flex gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900 ring-1 ring-emerald-200 ring-inset"
        >
          <MailCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
          <span>
            Sendt på e-post til <strong className="font-medium">{link.email}</strong>. Kommer den
            ikke fram, kan du sende lenken under selv, men bare til {link.email}. Den vises bare nå.
          </span>
        </p>
      ) : (
        <p
          role={link.emailError ? 'alert' : undefined}
          className="flex gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          <span>
            {link.emailError && (
              <>
                <strong className="font-medium">E-posten til {link.email} ble ikke sendt.</strong>{' '}
                {link.emailError} Lenken er laget og virker; send den selv.{' '}
              </>
            )}
            Lenken vises bare nå. Send den bare til {link.email}, for eksempel på SMS. Den som åpner
            den først, {opener} {link.email}.
          </span>
        </p>
      )}
      <Field label="Lenke">
        <div className="flex gap-2">
          <Input
            readOnly
            value={link.url}
            onFocus={(e) => e.currentTarget.select()}
            className="font-mono text-xs"
            aria-label="Lenke"
          />
          <CopyButton text={link.url} label="Kopier lenke" />
        </div>
      </Field>
      <div>
        <label htmlFor={messageId} className="text-sm font-medium text-stone-900">
          Melding å sende
        </label>
        <Textarea
          id={messageId}
          readOnly
          rows={4}
          value={message}
          onFocus={(e) => e.currentTarget.select()}
          className="mt-1.5"
        />
        <div className="mt-2">
          <CopyButton text={message} label="Kopier melding" />
        </div>
      </div>
    </div>
  )
}

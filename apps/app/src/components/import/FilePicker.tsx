import { FileSpreadsheet, Upload } from 'lucide-react'
import { useId, useState, type DragEvent } from 'react'
import { IMPORT_MAX_MB } from '#/lib/import-client.ts'
import { cx, ErrorText } from '../ui.tsx'

const ACCEPT =
  '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv'

const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} kB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`

/**
 * Velg eller slipp et regneark (.xlsx eller .csv). Størrelse og filtype sjekkes
 * her for å spare en tur til serveren; serveren sjekker det samme.
 */
export function FilePicker({
  file,
  onFile,
  disabled,
}: {
  file: File | null
  onFile: (file: File) => void
  disabled?: boolean
}) {
  const id = useId()
  const [error, setError] = useState<string | null>(null)
  const [over, setOver] = useState(false)

  function pick(f: File | undefined) {
    if (!f) return
    if (!/\.(xlsx|csv)$/i.test(f.name)) {
      setError(
        'Velg en fil som slutter på .xlsx eller .csv. Gamle .xls-filer må lagres som .xlsx først.',
      )
      return
    }
    if (f.size > IMPORT_MAX_MB * 1024 * 1024) {
      setError(`Fila er for stor. Maks ${IMPORT_MAX_MB} MB.`)
      return
    }
    setError(null)
    onFile(f)
  }

  function drop(e: DragEvent) {
    e.preventDefault()
    setOver(false)
    if (!disabled) pick(e.dataTransfer.files[0])
  }

  return (
    <div className="space-y-2">
      <label
        htmlFor={id}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cx(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed px-6 py-8 text-center transition',
          over
            ? 'border-brand-500 bg-brand-50/50'
            : 'border-stone-300 bg-white/50 hover:border-stone-400',
          disabled && 'pointer-events-none opacity-60',
        )}
      >
        {file ? (
          <>
            <FileSpreadsheet className="size-6 text-brand-600" aria-hidden />
            <span className="text-sm font-medium text-stone-900">{file.name}</span>
            <span className="text-xs text-stone-500">
              {size(file.size)} · Klikk eller slipp en annen fil for å bytte
            </span>
          </>
        ) : (
          <>
            <Upload className="size-6 text-stone-400" aria-hidden />
            <span className="text-sm font-medium text-stone-900">
              Velg et regneark, eller slipp det her
            </span>
            <span className="text-xs text-stone-500">
              .xlsx eller .csv, maks {IMPORT_MAX_MB} MB
            </span>
          </>
        )}
        <input
          id={id}
          type="file"
          accept={ACCEPT}
          disabled={disabled}
          className="sr-only"
          onChange={(e) => {
            pick(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </label>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  )
}

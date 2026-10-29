import type { CompanyLogoUrls } from '@esaf/core'
import { useRouter } from '@tanstack/react-router'
import { Check, ImageUp, LoaderCircle, Trash2 } from 'lucide-react'
import { useRef, useState, type DragEvent } from 'react'
import { checkPhotoFile, deleteLogo, PHOTO_ACCEPT, uploadLogo } from '#/lib/photos.ts'
import { Progress } from './PhotoUpload.tsx'
import { Button, CompanyLogo, cx, ErrorText } from './ui.tsx'

type Busy = { kind: 'upload'; preview: string; progress: number } | { kind: 'remove' } | null

/** Henter den nye logoen før forhåndsvisningen tas bort, så den ikke blinker. */
function preload(logo: CompanyLogoUrls) {
  const img = new Image()
  img.sizes = '80px'
  img.srcset = `${logo.small} 64w, ${logo.large} 256w`
  img.src = logo.small
  return img.decode().catch(() => {})
}

/** En melding for filer som åpenbart ikke kan brukes, ellers `null`. */
function checkLogoFile(file: File) {
  if (file.type === 'image/svg+xml') {
    return 'SVG støttes ikke. Lagre logoen som PNG, gjerne med gjennomsiktig bakgrunn.'
  }
  return checkPhotoFile(file)
}

/**
 * Last opp, bytt og fjern logoen til et selskap, som profilbildet: endringen
 * lagres med en gang, uten resten av skjemaet. Mens logoen lastes opp, vises den
 * slik den blir (hele logoen, sentrert på hvitt). En fil kan også slippes på feltet.
 */
export function LogoUpload({
  companyId,
  name,
  logo,
}: {
  companyId: string
  name: string
  logo: CompanyLogoUrls | null
}) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  async function upload(file: File) {
    const problem = checkLogoFile(file)
    setDone(null)
    setError(problem)
    if (problem) return
    const preview = URL.createObjectURL(file)
    setBusy({ kind: 'upload', preview, progress: 0 })
    try {
      const uploaded = await uploadLogo(companyId, file, (progress) =>
        setBusy({ kind: 'upload', preview, progress }),
      )
      await preload(uploaded)
      // Henter siden på nytt, så den nye logoen vises overalt.
      await router.invalidate()
      setDone('Logoen er lagret.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke laste opp logoen.')
    } finally {
      URL.revokeObjectURL(preview)
      setBusy(null)
    }
  }

  async function remove() {
    if (!confirm(`Fjerne logoen til ${name}?`)) return
    setDone(null)
    setError(null)
    setBusy({ kind: 'remove' })
    try {
      await deleteLogo(companyId)
      await router.invalidate()
      setDone('Logoen er fjernet.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke fjerne logoen.')
    } finally {
      setBusy(null)
    }
  }

  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragging(true)
  }
  function onDragLeave(e: DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
  }
  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file && !busy) void upload(file)
  }

  const uploading = busy?.kind === 'upload' ? busy : null
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cx(
        'flex flex-col gap-4 rounded-xl transition sm:flex-row sm:items-center sm:gap-6',
        dragging && 'bg-brand-50 ring-2 ring-brand-400 ring-offset-8 ring-offset-brand-50',
      )}
    >
      <div className="relative size-16 shrink-0 sm:size-20">
        {uploading ? (
          <span className="grid size-full place-items-center rounded-2xl bg-white p-2 ring-1 ring-stone-200 ring-inset sm:p-2.5">
            <img src={uploading.preview} alt="" className="size-full object-contain" />
          </span>
        ) : (
          <CompanyLogo name={name} logo={logo} size="xl" />
        )}
        {busy && (
          <span className="absolute inset-0 grid place-items-center rounded-2xl bg-stone-950/30 text-white">
            <LoaderCircle className="size-6 animate-spin" aria-hidden />
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => input.current?.click()}
            disabled={busy !== null}
          >
            <ImageUp className="size-4" aria-hidden /> {logo ? 'Bytt logo' : 'Last opp logo'}
          </Button>
          {logo && (
            <Button
              variant="danger"
              onClick={remove}
              disabled={busy !== null}
              aria-label="Fjern logoen"
            >
              <Trash2 className="size-4" aria-hidden />{' '}
              {busy?.kind === 'remove' ? 'Fjerner …' : 'Fjern'}
            </Button>
          )}
        </div>
        {uploading ? (
          <Progress share={uploading.progress} />
        ) : (
          <p className="text-xs leading-relaxed text-stone-500">
            PNG med gjennomsiktig bakgrunn blir finest. JPEG og WebP går også, maks 10 MB. Hele
            logoen vises, uten beskjæring.
          </p>
        )}
        {error && <ErrorText>{error}</ErrorText>}
        {done && (
          <p role="status" className="flex items-center gap-1.5 text-sm text-stone-600">
            <Check className="size-4 text-brand-600" aria-hidden /> {done}
          </p>
        )}
      </div>

      <input
        ref={input}
        type="file"
        accept={PHOTO_ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Tømmes, så samme fil kan velges igjen etter en feil.
          e.target.value = ''
          if (file) void upload(file)
        }}
      />
    </div>
  )
}

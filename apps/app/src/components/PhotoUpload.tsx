import type { ProfilePhoto } from '@esaf/core'
import { useRouter } from '@tanstack/react-router'
import { Check, ImageUp, LoaderCircle, Trash2 } from 'lucide-react'
import { useRef, useState, type DragEvent } from 'react'
import { checkPhotoFile, deletePhoto, PHOTO_ACCEPT, uploadPhoto } from '#/lib/photos.ts'
import { Avatar, Button, cx, ErrorText } from './ui.tsx'

type Busy = { kind: 'upload'; preview: string; progress: number } | { kind: 'remove' } | null

/** Henter det nye bildet før forhåndsvisningen tas bort, så det ikke blinker. */
function preload(photo: ProfilePhoto) {
  const img = new Image()
  img.sizes = '112px'
  img.srcset = `${photo.small} 192w, ${photo.large} 512w`
  img.src = photo.small
  return img.decode().catch(() => {})
}

function Progress({ share }: { share: number }) {
  const percent = Math.round(share * 100)
  const processing = percent >= 100
  return (
    <div className="space-y-1.5">
      <div
        role="progressbar"
        aria-label="Opplasting av bildet"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 max-w-xs overflow-hidden rounded-full bg-stone-200"
      >
        <div
          className={cx(
            'h-full rounded-full bg-brand-500 transition-[width]',
            processing && 'animate-pulse',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-xs text-stone-500" aria-live="polite">
        {processing ? 'Behandler bildet …' : `Laster opp … ${percent}\u00a0%`}
      </p>
    </div>
  )
}

/**
 * Last opp, bytt og fjern et profilbilde. Endringen lagres med en gang, uten
 * resten av skjemaet, og en opplasting fullføres selv om man går videre før den
 * er ferdig. Mens bildet lastes opp, vises det beskåret slik det blir (et
 * kvadrat fra midten). Et bilde kan også slippes på feltet.
 */
export function PhotoUpload({
  personId,
  fullName,
  photo,
  isOwn,
}: {
  personId: string
  fullName: string
  photo: ProfilePhoto | null
  isOwn: boolean
}) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  async function upload(file: File) {
    const problem = checkPhotoFile(file)
    setDone(null)
    setError(problem)
    if (problem) return
    const preview = URL.createObjectURL(file)
    setBusy({ kind: 'upload', preview, progress: 0 })
    try {
      const uploaded = await uploadPhoto(personId, file, (progress) =>
        setBusy({ kind: 'upload', preview, progress }),
      )
      await preload(uploaded)
      // Henter profilen og menyen på nytt, så det nye bildet vises overalt.
      await router.invalidate()
      setDone('Bildet er lagret.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke laste opp bildet.')
    } finally {
      URL.revokeObjectURL(preview)
      setBusy(null)
    }
  }

  async function remove() {
    const question = isOwn ? 'Fjerne profilbildet ditt?' : `Fjerne profilbildet til ${fullName}?`
    if (!confirm(question)) return
    setDone(null)
    setError(null)
    setBusy({ kind: 'remove' })
    try {
      await deletePhoto(personId)
      await router.invalidate()
      setDone('Bildet er fjernet.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kunne ikke fjerne bildet.')
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
      <div className="relative size-24 shrink-0 sm:size-28">
        {uploading ? (
          <img
            src={uploading.preview}
            alt=""
            className="size-full rounded-full bg-stone-100 object-cover"
          />
        ) : (
          <Avatar name={fullName} photo={photo} size="xl" />
        )}
        {busy && (
          <span className="absolute inset-0 grid place-items-center rounded-full bg-stone-950/30 text-white">
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
            <ImageUp className="size-4" aria-hidden /> {photo ? 'Bytt bilde' : 'Last opp bilde'}
          </Button>
          {photo && (
            <Button
              variant="danger"
              onClick={remove}
              disabled={busy !== null}
              aria-label="Fjern profilbildet"
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
            JPEG, PNG eller WebP, maks 10 MB. Bildet beskjæres til et kvadrat fra midten.
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

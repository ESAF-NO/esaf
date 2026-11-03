import type { AssetView } from '@esaf/core'
import { useRouter } from '@tanstack/react-router'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  File,
  FileSpreadsheet,
  FileText,
  FileUp,
  ImagePlus,
  LoaderCircle,
  Paperclip,
  Presentation,
  Trash2,
  X,
} from 'lucide-react'
import {
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  ATTACHMENT_ACCEPT,
  checkAssetFile,
  DOCUMENT_ACCEPT,
  documentLabels,
  fileSize,
  IMAGE_ACCEPT,
  MAX_ATTACHMENTS,
  uploadAsset,
  type UploadTarget,
} from '#/lib/assets.ts'
import { deleteAsset } from '#/lib/assets.functions.ts'
import { Button, Card, cx, ErrorText } from './ui.tsx'

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback

// ---------------------------------------------------------------------------
// Opplasting
// ---------------------------------------------------------------------------

/** En fil som lastes opp, eller som feilet. */
type Pending = {
  key: string
  name: string
  progress: number
  /** Forhåndsvisning av bilder mens de lastes opp. */
  preview: string | null
  error: string | null
}

/**
 * Kø for opplastinger: filene sendes én og én, med fremdrift per fil. Det
 * skåner serveren, som uansett behandler ett bilde om gangen. `onUploaded`
 * kalles for hver fil som er lagret.
 */
function useUploadQueue(
  target: UploadTarget,
  { imagesOnly = false, room = Infinity }: { imagesOnly?: boolean; room?: number },
  onUploaded: (asset: AssetView) => void,
) {
  const [pending, setPending] = useState<Pending[]>([])
  const [error, setError] = useState<string | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const update = (key: string, patch: Partial<Pending>) =>
    setPending((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)))

  function add(files: File[]) {
    setError(null)
    const waiting = pending.filter((p) => !p.error).length
    const free = room - waiting
    if (files.length > free) {
      setError(
        free <= 0
          ? `Det er ikke plass til flere filer her (maks ${room + waiting}).`
          : `Bare ${free} ${free === 1 ? 'fil' : 'filer'} til får plass. Velg færre.`,
      )
      if (free <= 0) return
      files = files.slice(0, free)
    }
    for (const file of files) {
      const key = crypto.randomUUID()
      const problem = checkAssetFile(file, { imagesOnly })
      const preview =
        !problem && IMAGE_ACCEPT.split(',').includes(file.type) ? URL.createObjectURL(file) : null
      setPending((list) => [
        ...list,
        { key, name: file.name, progress: 0, preview, error: problem },
      ])
      if (problem) continue
      queue.current = queue.current.then(async () => {
        try {
          const asset = await uploadAsset(target, file, (progress) => update(key, { progress }))
          onUploaded(asset)
          setPending((list) => list.filter((p) => p.key !== key))
          if (preview) URL.revokeObjectURL(preview)
        } catch (err) {
          update(key, { error: errorText(err, 'Kunne ikke laste opp fila.') })
        }
      })
    }
  }

  function dismiss(key: string) {
    setPending((list) => {
      const gone = list.find((p) => p.key === key)
      if (gone?.preview) URL.revokeObjectURL(gone.preview)
      return list.filter((p) => p.key !== key)
    })
  }

  const busy = pending.some((p) => !p.error)
  return { pending, add, dismiss, busy, error, setError, waiting: queue }
}

/** Dra og slipp filer, og lim inn bilder (skjermbilder), på et område. */
function useDropZone(add: (files: File[]) => void, disabled = false) {
  const [dragging, setDragging] = useState(false)
  return {
    dragging,
    props: {
      onDragOver(e: DragEvent) {
        if (disabled || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      },
      onDragLeave(e: DragEvent) {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      },
      onDrop(e: DragEvent) {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDragging(false)
        if (!disabled) add([...e.dataTransfer.files])
      },
      onPaste(e: ClipboardEvent) {
        const files = [...e.clipboardData.files]
        if (!files.length || disabled) return
        e.preventDefault()
        add(files)
      },
    },
  }
}

/**
 * Vedleggene i et innlegg eller en kommentar mens det skrives: filer lastes opp
 * med en gang og festes når innlegget lagres (`ids`). Filer som lastes opp her
 * og fjernes igjen før lagring, slettes med en gang; de andre forsvinner først
 * når innlegget lagres uten dem.
 */
export function useAttachments(
  target: { til: 'innlegg' | 'kommentar' },
  initial: AssetView[] = [],
) {
  const [items, setItems] = useState<AssetView[]>(initial)
  const fresh = useRef(new Set<string>())
  const uploads = useUploadQueue(target, { room: MAX_ATTACHMENTS - items.length }, (asset) => {
    fresh.current.add(asset.id)
    setItems((list) => [...list, asset])
  })
  const drop = useDropZone(uploads.add)

  function remove(asset: AssetView) {
    setItems((list) => list.filter((a) => a.id !== asset.id))
    if (fresh.current.delete(asset.id)) {
      // Ble lastet opp nå og står ikke i noe innlegg: slett den med en gang.
      deleteAsset({ data: { assetId: asset.id } }).catch(() => {})
    }
  }

  /** Etter lagring: det som er lastet opp, hører nå til innlegget. */
  function reset(next: AssetView[] = []) {
    fresh.current.clear()
    setItems(next)
  }

  return { ...uploads, items, ids: items.map((a) => a.id), remove, reset, drop }
}

export type Attachments = ReturnType<typeof useAttachments>

function ProgressBar({ share, label }: { share: number; label: string }) {
  const percent = Math.round(share * 100)
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1 overflow-hidden rounded-full bg-stone-200"
    >
      <div
        className={cx(
          'h-full rounded-full bg-brand-500 transition-[width]',
          percent >= 100 && 'animate-pulse',
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}

/** Filer som lastes opp, med fremdrift, og de som feilet, med meldingen. */
function PendingList({
  pending,
  onDismiss,
}: {
  pending: Pending[]
  onDismiss: (key: string) => void
}) {
  if (!pending.length) return null
  return (
    <ul className="space-y-2" aria-live="polite">
      {pending.map((p) => (
        <li
          key={p.key}
          className={cx(
            'flex items-center gap-3 rounded-xl p-2 ring-1 ring-inset',
            p.error ? 'bg-red-50 ring-red-200' : 'bg-white ring-stone-200',
          )}
        >
          {p.preview ? (
            <img src={p.preview} alt="" className="size-10 shrink-0 rounded-lg object-cover" />
          ) : (
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-500">
              {p.error ? (
                <File className="size-4" aria-hidden />
              ) : (
                <LoaderCircle className="size-4 animate-spin" aria-hidden />
              )}
            </span>
          )}
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="truncate text-sm font-medium text-stone-900">{p.name}</p>
            {p.error ? (
              <p className="text-xs text-red-700">{p.error}</p>
            ) : (
              <>
                <ProgressBar share={p.progress} label={`Laster opp ${p.name}`} />
                <p className="text-xs text-stone-500">
                  {p.progress >= 1
                    ? 'Behandler …'
                    : p.progress > 0
                      ? `Laster opp … ${Math.round(p.progress * 100)}\u00a0%`
                      : 'Venter …'}
                </p>
              </>
            )}
          </div>
          {p.error && (
            <button
              type="button"
              onClick={() => onDismiss(p.key)}
              className="rounded-md p-1 text-stone-400 hover:bg-white hover:text-stone-700"
              aria-label={`Fjern ${p.name} fra lista`}
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

/** Knapp som åpner filvelgeren. */
function PickButton({
  children,
  accept,
  multiple = true,
  onFiles,
  disabled,
  variant = 'ghost',
  size = 'sm',
}: {
  children: ReactNode
  accept: string
  multiple?: boolean
  onFiles: (files: File[]) => void
  disabled?: boolean
  variant?: 'ghost' | 'secondary'
  size?: 'sm' | 'md'
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button
        variant={variant}
        size={size}
        onClick={() => input.current?.click()}
        disabled={disabled}
      >
        {children}
      </Button>
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          // Tømmes, så samme fil kan velges igjen etter en feil.
          e.target.value = ''
          if (files.length) onFiles(files)
        }}
      />
    </>
  )
}

/**
 * Vedleggene i skrivefeltet: bilder som små miniatyrer og dokumenter som
 * filbrikker, med kryss for å ta dem bort, og «Legg ved fil». Selve slipp- og
 * lim-inn-området er skjemaet rundt (`attachments.drop.props`).
 */
export function AttachmentEditor({
  attachments: a,
  compact = false,
  button = true,
}: {
  attachments: Attachments
  /** I kommentarfeltet: bare knappen og vedleggene, uten forklaring. */
  compact?: boolean
  /** Uten «Legg ved fil»: knappen står i verktøylinja i `Composer`. */
  button?: boolean
}) {
  const images = a.items.filter((i) => i.image)
  const documents = a.items.filter((i) => !i.image)
  const full = a.items.length >= MAX_ATTACHMENTS
  return (
    <div className="space-y-2">
      {images.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {images.map((img) => (
            <li key={img.id} className="group relative">
              <img
                src={img.image!.small}
                alt={img.name}
                className="size-20 rounded-lg bg-stone-100 object-cover ring-1 ring-stone-200"
              />
              <button
                type="button"
                onClick={() => a.remove(img)}
                className="absolute -top-1.5 -right-1.5 grid size-6 place-items-center rounded-full bg-stone-900 text-white shadow ring-2 ring-white transition hover:bg-red-600"
                aria-label={`Fjern ${img.name}`}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {documents.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {documents.map((doc) => (
            <FileChip key={doc.id} asset={doc} onRemove={() => a.remove(doc)} removeLabel="Fjern" />
          ))}
        </ul>
      )}
      <PendingList pending={a.pending} onDismiss={a.dismiss} />
      {a.error && <ErrorText>{a.error}</ErrorText>}
      {button && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <PickButton accept={ATTACHMENT_ACCEPT} onFiles={a.add} disabled={full}>
            <Paperclip className="size-4" aria-hidden /> Legg ved fil
          </PickButton>
          {!compact && (
            <p className="text-xs text-stone-500">
              Bilder (JPEG, PNG, WebP) og dokumenter (PDF, Word, Excel, PowerPoint, tekst, CSV),
              maks 25 MB og {MAX_ATTACHMENTS} filer. Dra filer hit, eller lim inn et bilde.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Visning
// ---------------------------------------------------------------------------

function DocumentIcon({ asset, className }: { asset: AssetView; className?: string }) {
  const Icon =
    asset.documentType === 'xlsx' || asset.documentType === 'csv'
      ? FileSpreadsheet
      : asset.documentType === 'pptx'
        ? Presentation
        : asset.documentType
          ? FileText
          : File
  return <Icon className={className} aria-hidden />
}

/** Ett dokument: ikon, navn, type og størrelse. Klikk laster det ned. */
export function FileChip({
  asset,
  onRemove,
  removing = false,
  removeLabel = 'Slett',
  meta,
}: {
  asset: AssetView
  onRemove?: () => void
  removing?: boolean
  removeLabel?: string
  /** Ekstra linje under navnet, for eksempel hvem som lastet opp. */
  meta?: ReactNode
}) {
  const type = asset.documentType
    ? documentLabels[asset.documentType]
    : asset.image
      ? 'Bilde'
      : 'Fil'
  return (
    <li className="group flex items-center gap-3 rounded-xl bg-white p-2 pr-2.5 ring-1 ring-stone-200 transition ring-inset hover:ring-stone-300">
      <span
        className={cx(
          'grid size-10 shrink-0 place-items-center rounded-lg ring-1 ring-inset',
          asset.documentType === 'pdf'
            ? 'bg-red-50 text-red-700 ring-red-100'
            : asset.documentType === 'xlsx' || asset.documentType === 'csv'
              ? 'bg-emerald-50 text-emerald-700 ring-emerald-100'
              : asset.documentType === 'pptx'
                ? 'bg-orange-50 text-orange-700 ring-orange-100'
                : asset.documentType === 'docx'
                  ? 'bg-sky-50 text-sky-700 ring-sky-100'
                  : 'bg-stone-100 text-stone-600 ring-stone-200',
        )}
      >
        <DocumentIcon asset={asset} className="size-5" />
      </span>
      <a
        href={asset.url}
        download={asset.name}
        className="min-w-0 flex-1 focus:outline-none"
        title={`Last ned ${asset.name}`}
      >
        <span className="block truncate text-sm font-medium text-stone-900 group-hover:text-brand-700">
          {asset.name}
        </span>
        <span className="block truncate text-xs text-stone-500">
          {type} · {fileSize(asset.byteSize)}
          {meta && <> · {meta}</>}
        </span>
      </a>
      <a
        href={asset.url}
        download={asset.name}
        className="hidden rounded-md p-1.5 text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 sm:block"
        aria-label={`Last ned ${asset.name}`}
      >
        <Download className="size-4" aria-hidden />
      </a>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          className="rounded-md p-1.5 text-stone-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
          aria-label={`${removeLabel} ${asset.name}`}
        >
          {removing ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
          ) : (
            <Trash2 className="size-4" aria-hidden />
          )}
        </button>
      )}
    </li>
  )
}

/** Sletter en fil etter en bekreftelse, og henter siden på nytt. */
function useRemoveAsset() {
  const router = useRouter()
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function remove(asset: AssetView) {
    const question = asset.own
      ? `Slette ${asset.name}?`
      : `Fjerne ${asset.name}? Det blir stående i loggen at du fjernet den.`
    if (!confirm(question)) return false
    setRemoving(asset.id)
    setError(null)
    try {
      await deleteAsset({ data: { assetId: asset.id } })
      await router.invalidate()
      return true
    } catch (err) {
      setError(errorText(err, 'Kunne ikke slette fila.'))
      return false
    } finally {
      setRemoving(null)
    }
  }
  return { remove, removing, error }
}

/**
 * Bildevisning i hele vinduet, på det innebygde `<dialog>`-elementet (fokus
 * holdes inne, Esc lukker). Piltastene blar.
 */
function Lightbox({
  images,
  index,
  onIndex,
  onClose,
  onRemove,
  removing,
  caption,
}: {
  images: AssetView[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
  onRemove?: (asset: AssetView) => void
  removing: boolean
  caption?: (asset: AssetView) => ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const image = images[index]

  // Som `Dialog`: åpnes når den monteres, og fokus går tilbake når den lukkes.
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  if (!image) return null
  const go = (step: number) => onIndex((index + step + images.length) % images.length)
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') go(-1)
    else if (e.key === 'ArrowRight') go(1)
  }
  const control =
    'grid size-10 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20 disabled:opacity-40'

  return (
    <dialog
      ref={ref}
      aria-label={`Bilde ${index + 1} av ${images.length}: ${image.name}`}
      onKeyDown={onKeyDown}
      onClose={() => !ref.current?.open && onClose()}
      className="m-0 h-dvh max-h-none w-screen max-w-none bg-stone-950/95 p-0 text-white backdrop:bg-stone-950/80"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <p className="min-w-0 truncate text-sm text-white/80">
            <span className="tabular-nums">
              {index + 1} av {images.length}
            </span>
            {caption && <span className="text-white/60"> · {caption(image)}</span>}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {onRemove && image.canRemove && (
              <button
                type="button"
                onClick={() => onRemove(image)}
                disabled={removing}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm text-white/80 transition hover:bg-red-600/80 hover:text-white disabled:opacity-50"
              >
                <Trash2 className="size-4" aria-hidden /> {removing ? 'Sletter …' : 'Slett'}
              </button>
            )}
            <button type="button" onClick={onClose} className={control} aria-label="Lukk">
              <X className="size-5" aria-hidden />
            </button>
          </div>
        </div>
        <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-4 sm:px-16">
          <img
            key={image.id}
            src={image.image!.large}
            alt={image.name}
            width={image.width ?? undefined}
            height={image.height ?? undefined}
            className="max-h-full max-w-full rounded-md object-contain"
          />
          {images.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => go(-1)}
                className={cx(control, 'absolute top-1/2 left-2 -translate-y-1/2 sm:left-4')}
                aria-label="Forrige bilde"
              >
                <ChevronLeft className="size-6" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => go(1)}
                className={cx(control, 'absolute top-1/2 right-2 -translate-y-1/2 sm:right-4')}
                aria-label="Neste bilde"
              >
                <ChevronRight className="size-6" aria-hidden />
              </button>
            </>
          )}
        </div>
      </div>
    </dialog>
  )
}

/**
 * Bilder i et rutenett som åpnes i full størrelse. Ett bilde i et innlegg vises
 * stort i riktig format; flere vises som kvadrater (bare utsnittet i visningen,
 * bildet er lagret helt).
 */
export function ImageGrid({
  images,
  layout = 'post',
  removable = () => false,
  caption,
}: {
  images: AssetView[]
  layout?: 'post' | 'album'
  /** Om den innloggede kan slette eller fjerne et bilde her. */
  removable?: (asset: AssetView) => boolean
  caption?: (asset: AssetView) => ReactNode
}) {
  const [open, setOpen] = useState<number | null>(null)
  const { remove, removing, error } = useRemoveAsset()
  if (!images.length) return null
  const single = layout === 'post' && images.length === 1
  return (
    <>
      <ul
        className={cx(
          'grid gap-2',
          single
            ? 'grid-cols-1'
            : layout === 'album'
              ? 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-5'
              : 'grid-cols-2 sm:grid-cols-3',
        )}
      >
        {images.map((img, i) => (
          <li key={img.id}>
            <button
              type="button"
              onClick={() => setOpen(i)}
              className="block w-full overflow-hidden rounded-xl bg-stone-100 ring-1 ring-stone-200 transition hover:ring-stone-400 focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label={`Vis ${img.name} i full størrelse`}
            >
              <img
                src={img.image!.small}
                srcSet={`${img.image!.small} 400w, ${img.image!.large} 1600w`}
                sizes={
                  single ? '(min-width: 768px) 720px, 100vw' : '(min-width: 640px) 240px, 50vw'
                }
                alt=""
                loading="lazy"
                decoding="async"
                width={img.width ?? undefined}
                height={img.height ?? undefined}
                className={cx(
                  'w-full',
                  single ? 'h-auto max-h-[28rem] object-contain' : 'aspect-square object-cover',
                )}
              />
            </button>
          </li>
        ))}
      </ul>
      {error && <ErrorText>{error}</ErrorText>}
      {open !== null && (
        <Lightbox
          images={images.map((img) => ({ ...img, canRemove: removable(img) }))}
          index={Math.min(open, images.length - 1)}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          removing={removing !== null}
          caption={caption}
          onRemove={async (img) => {
            if (await remove(img)) {
              if (images.length <= 1) setOpen(null)
              else setOpen((i) => Math.min(i ?? 0, images.length - 2))
            }
          }}
        />
      )}
    </>
  )
}

/** Vedleggene i et innlegg eller en kommentar: bilder i rutenett, dokumenter som filbrikker. */
export function AttachmentList({
  attachments,
  removable = () => false,
  className,
}: {
  attachments: AssetView[]
  removable?: (asset: AssetView) => boolean
  className?: string
}) {
  const { remove, removing, error } = useRemoveAsset()
  if (!attachments.length) return null
  const images = attachments.filter((a) => a.image)
  const documents = attachments.filter((a) => !a.image)
  return (
    <div className={cx('space-y-2', className)}>
      <ImageGrid images={images} removable={removable} />
      {documents.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {documents.map((doc) => (
            <FileChip
              key={doc.id}
              asset={doc}
              removing={removing === doc.id}
              removeLabel="Fjern"
              onRemove={removable(doc) ? () => void remove(doc) : undefined}
            />
          ))}
        </ul>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Album og dokumenter på arrangementer og selskaper
// ---------------------------------------------------------------------------

/** Laster opp med en gang (album og dokumenter) og henter siden på nytt etterpå. */
function useDirectUploads(target: UploadTarget, options: { imagesOnly?: boolean; room: number }) {
  const router = useRouter()
  const uploads = useUploadQueue(target, options, () => {
    void router.invalidate()
  })
  const drop = useDropZone(uploads.add)
  return { ...uploads, drop }
}

/** «Bilder» på et arrangement: albumet, opplasting og visning i full størrelse. */
export function EventAlbum({
  eventId,
  photos,
  canUpload,
  upcoming,
  max,
}: {
  eventId: string
  photos: AssetView[]
  canUpload: boolean
  upcoming: boolean
  /** Høyst så mange bilder i albumet. */
  max: number
}) {
  const uploads = useDirectUploads(
    { til: 'album', id: eventId },
    { imagesOnly: true, room: Math.max(0, max - photos.length) },
  )
  if (upcoming && !photos.length) return null
  return (
    <section
      aria-labelledby="bilder"
      {...(canUpload ? uploads.drop.props : {})}
      className={cx(
        'rounded-2xl transition',
        uploads.drop.dragging &&
          'bg-brand-50 ring-2 ring-brand-400 ring-offset-8 ring-offset-brand-50',
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="bilder" className="flex items-baseline gap-2 text-sm font-semibold text-stone-950">
          Bilder
          {photos.length > 0 && (
            <span className="text-xs font-normal text-stone-500 tabular-nums">{photos.length}</span>
          )}
        </h2>
        {canUpload && (
          <PickButton accept={IMAGE_ACCEPT} onFiles={uploads.add} variant="secondary">
            <ImagePlus className="size-4" aria-hidden /> Legg inn bilder
          </PickButton>
        )}
      </div>
      <div className="space-y-3">
        <PendingList pending={uploads.pending} onDismiss={uploads.dismiss} />
        {uploads.error && <ErrorText>{uploads.error}</ErrorText>}
        {photos.length ? (
          <ImageGrid
            images={photos}
            layout="album"
            removable={(p) => p.canRemove}
            caption={(p) => (p.uploadedBy ? `Lagt inn av ${p.uploadedBy.fullName}` : null)}
          />
        ) : (
          <p className="rounded-2xl border border-dashed border-stone-300 px-4 py-8 text-center text-sm text-stone-500">
            {canUpload
              ? 'Ingen bilder ennå. Legg inn bilder fra arrangementet, eller dra dem hit. Metadata som sted fjernes.'
              : 'Ingen bilder ennå. De som var der, kan legge inn bilder.'}
          </p>
        )}
      </div>
    </section>
  )
}

/** «Dokumenter» på et arrangement eller et selskap. Alle medlemmer kan laste ned. */
export function DocumentsCard({
  target,
  documents,
  canUpload,
  max,
  emptyText,
  uploadHint,
}: {
  target: { til: 'arrangement' | 'selskap'; id: string }
  documents: AssetView[]
  canUpload: boolean
  max: number
  emptyText: string
  uploadHint: string
}) {
  const uploads = useDirectUploads(target, { room: Math.max(0, max - documents.length) })
  const { remove, removing, error } = useRemoveAsset()
  if (!canUpload && !documents.length) return null
  return (
    <Card
      className={cx('p-5 transition', uploads.drop.dragging && 'bg-brand-50 ring-2 ring-brand-400')}
      {...(canUpload ? uploads.drop.props : {})}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-stone-950">Dokumenter</h2>
        {canUpload && (
          <PickButton accept={DOCUMENT_ACCEPT + ',' + IMAGE_ACCEPT} onFiles={uploads.add}>
            <FileUp className="size-4" aria-hidden /> Last opp
          </PickButton>
        )}
      </div>
      <div className="mt-3 space-y-2">
        {documents.length > 0 ? (
          <ul className="space-y-2">
            {documents.map((doc) => (
              <FileChip
                key={doc.id}
                asset={doc}
                removing={removing === doc.id}
                onRemove={doc.canRemove ? () => void remove(doc) : undefined}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-stone-500">{emptyText}</p>
        )}
        <PendingList pending={uploads.pending} onDismiss={uploads.dismiss} />
        {(uploads.error || error) && <ErrorText>{uploads.error ?? error}</ErrorText>}
        {canUpload && <p className="text-xs text-stone-500">{uploadHint}</p>}
      </div>
    </Card>
  )
}

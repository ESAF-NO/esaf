import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { PostForm } from '#/components/PostForm.tsx'
import { channelKeys } from '#/lib/channels.ts'
import { submitPost } from '#/lib/feed.functions.ts'

export const Route = createFileRoute('/_konto/feed/ny')({
  validateSearch: z.object({ kanal: z.enum(channelKeys).optional().catch(undefined) }),
  head: () => ({ meta: [{ title: 'Nytt innlegg – ESAF' }] }),
  component: NewPost,
})

function NewPost() {
  const { kanal } = Route.useSearch()
  const router = useRouter()

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        to="/feed"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900"
      >
        <ArrowLeft className="size-4" aria-hidden /> Tilbake
      </Link>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-stone-950">Nytt innlegg</h1>

      <PostForm
        initial={{ channel: kanal ?? 'sporsmal', title: '', body: '', url: '' }}
        submitLabel="Publiser"
        savingLabel="Publiserer …"
        autoFocus
        onSubmit={async (values) => {
          const postId = await submitPost({ data: values })
          await router.navigate({ to: '/feed/$postId', params: { postId } })
        }}
        cancel={
          <Link
            to="/feed"
            className="inline-flex h-10 items-center px-3 text-sm text-stone-600 hover:text-stone-900"
          >
            Avbryt
          </Link>
        }
      />
    </div>
  )
}

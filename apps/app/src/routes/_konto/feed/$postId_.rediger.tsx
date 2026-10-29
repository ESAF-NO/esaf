import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { PostForm } from '#/components/PostForm.tsx'
import { editPost, fetchEditablePost } from '#/lib/feed.functions.ts'

// `$postId_` gjør at siden ikke ligger inne i innleggssiden, men har samme adresse under den.
export const Route = createFileRoute('/_konto/feed/$postId_/rediger')({
  // Bare forfatteren får innlegget. Andre får 404 fra serveren.
  loader: ({ params }) => fetchEditablePost({ data: { postId: params.postId } }),
  head: () => ({ meta: [{ title: 'Rediger innlegg – ESAF' }] }),
  component: EditPost,
})

function EditPost() {
  const post = Route.useLoaderData()
  const router = useRouter()
  const back = { to: '/feed/$postId', params: { postId: post.id } } as const

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        {...back}
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900"
      >
        <ArrowLeft className="size-4" aria-hidden /> Tilbake til innlegget
      </Link>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-stone-950">Rediger innlegg</h1>

      <PostForm
        initial={{
          channel: post.channel,
          title: post.title,
          body: post.body,
          url: post.url ?? '',
        }}
        submitLabel="Lagre"
        savingLabel="Lagrer …"
        onSubmit={async (values) => {
          await editPost({ data: { postId: post.id, ...values } })
          // Innleggssiden kan ligge i hurtigbufferen; hent den på nytt så endringen vises.
          await router.invalidate()
          await router.navigate(back)
        }}
        cancel={
          <Link
            {...back}
            className="inline-flex h-10 items-center px-3 text-sm text-stone-600 hover:text-stone-900"
          >
            Avbryt
          </Link>
        }
      />
    </div>
  )
}

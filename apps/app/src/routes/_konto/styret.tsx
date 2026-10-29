import { createFileRoute, Link } from '@tanstack/react-router'
import { Landmark, Pencil } from 'lucide-react'
import { BoardSeatCard, FormerBoardRow } from '#/components/Board.tsx'
import { buttonClass, Card, EmptyState, ErrorText, PageHeader } from '#/components/ui.tsx'
import { fetchBoard } from '#/lib/board.functions.ts'

export const Route = createFileRoute('/_konto/styret')({
  loader: () => fetchBoard(),
  head: () => ({ meta: [{ title: 'Styret – ESAF' }] }),
  component: BoardPage,
  errorComponent: ({ error }) => (
    <ErrorText>{error instanceof Error ? error.message : 'Noe gikk galt.'}</ErrorText>
  ),
})

/** Styret nå, og alle som har sittet i styret før. */
function BoardPage() {
  const board = Route.useLoaderData()
  const { viewer } = Route.useRouteContext()
  const edit = viewer.permissions.includes('members.manage') && (
    <Link to="/admin/styret" className={buttonClass({ variant: 'secondary', size: 'sm' })}>
      <Pencil className="size-3.5" aria-hidden /> Endre styret
    </Link>
  )

  return (
    <>
      <PageHeader
        title="Styret"
        description="Styret leder ESAF mellom generalforsamlingene, og snakker med kullene gjennom kullrepresentantene."
        actions={edit}
      />

      {board.current.length === 0 && board.former.length === 0 ? (
        <EmptyState icon={Landmark} title="Styret er ikke lagt inn ennå">
          Når styret er lagt inn, ser du hvem som sitter i det her.
        </EmptyState>
      ) : (
        <div className="space-y-10">
          <section aria-labelledby="styret-na">
            <h2 id="styret-na" className="mb-3 text-sm font-semibold text-stone-950">
              Styret nå
            </h2>
            {board.current.length > 0 ? (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {board.current.map((s) => (
                  <li key={s.id}>
                    <BoardSeatCard seat={s} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-stone-500">Ingen sitter i styret nå.</p>
            )}
          </section>

          {board.former.length > 0 && (
            <section aria-labelledby="tidligere-styre">
              <h2 id="tidligere-styre" className="mb-3 text-sm font-semibold text-stone-950">
                Tidligere styremedlemmer
              </h2>
              <Card className="p-2">
                <ul className="grid gap-x-4 sm:grid-cols-2">
                  {board.former.map((m) => (
                    <li key={m.personId}>
                      <FormerBoardRow member={m} />
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}
        </div>
      )}
    </>
  )
}

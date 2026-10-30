import {
  addBoardMember,
  boardRoles,
  changeBoardRole,
  endBoardMember,
  getBoard,
  listBoardCandidates,
  listBoardOverview,
  removeBoardMember,
  updateBoardMember,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'

// Styret. Siden er for alle medlemmer; resten er Admin og krever members.manage.
// Rettigheter og full validering i @esaf/core.

const year = z.number().int().nullable()
const role = z.enum(boardRoles)

export const fetchBoard = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => getBoard(db, viewer)),
)

export const fetchBoardOverview = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listBoardOverview(db, viewer)),
)

export const fetchBoardCandidates = createServerFn({ method: 'GET' })
  .validator(z.object({ query: z.string().max(100) }))
  .handler(({ data }) => run((viewer) => listBoardCandidates(db, viewer, data.query)))

export const addBoardSeat = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      personId: z.uuid(),
      role,
      responsibility: z.string().max(1000),
      startYear: year,
      note: z.string().max(1000),
    }),
  )
  .handler(({ data }) => run((viewer) => addBoardMember(db, viewer, data)))

export const editBoardSeat = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.uuid(),
      role,
      responsibility: z.string().max(1000),
      startYear: year,
      endYear: year,
      note: z.string().max(1000),
    }),
  )
  .handler(({ data: { id, ...values } }) =>
    run((viewer) => updateBoardMember(db, viewer, id, values)),
  )

export const changeBoardSeatRole = createServerFn({ method: 'POST' })
  .validator(
    z.object({ id: z.uuid(), role, responsibility: z.string().max(1000), year: z.number().int() }),
  )
  .handler(({ data: { id, ...values } }) =>
    run((viewer) => changeBoardRole(db, viewer, id, values)),
  )

export const endBoardSeat = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid(), endYear: z.number().int() }))
  .handler(({ data }) =>
    run((viewer) => endBoardMember(db, viewer, data.id, { endYear: data.endYear })),
  )

export const removeBoardSeat = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid() }))
  .handler(({ data }) => run((viewer) => removeBoardMember(db, viewer, data.id)))

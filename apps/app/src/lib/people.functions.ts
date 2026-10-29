import {
  addPersonEmail,
  createProfile,
  findSimilarPeople,
  getPersonAdmin,
  listPeopleForAdmin,
  mergePeople,
  removePersonEmail,
  searchAllPeople,
  setPersonCohorts,
} from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withViewer as run } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'
import { storage } from '#/server/photos.server.ts'

// Personer for admins med `profiles.edit`. Rettigheter og full validering i @esaf/core.

const cohorts = z
  .array(
    z.object({
      graduationYear: z.number().int(),
      relation: z.enum(['student', 'staff', 'mentor']),
    }),
  )
  .max(20)

export const fetchAdminPeople = createServerFn({ method: 'GET' }).handler(() =>
  run((viewer) => listPeopleForAdmin(db, viewer)),
)

export const fetchPersonAdmin = createServerFn({ method: 'GET' })
  .validator(z.object({ personId: z.uuid() }))
  .handler(({ data }) => run((viewer) => getPersonAdmin(db, viewer, data.personId)))

export const newProfile = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      fullName: z.string().max(500),
      cohorts,
      emails: z.array(z.string().max(500)).max(20),
      status: z.enum(['active', 'pending']),
    }),
  )
  .handler(({ data }) => run((viewer) => createProfile(db, viewer, data)))

export const fetchSimilarPeople = createServerFn({ method: 'GET' })
  .validator(z.object({ fullName: z.string().max(200), years: z.array(z.number().int()).max(20) }))
  .handler(({ data }) => run((viewer) => findSimilarPeople(db, viewer, data)))

export const saveCohorts = createServerFn({ method: 'POST' })
  .validator(z.object({ personId: z.uuid(), cohorts }))
  .handler(({ data }) => run((viewer) => setPersonCohorts(db, viewer, data.personId, data.cohorts)))

export const addEmail = createServerFn({ method: 'POST' })
  .validator(z.object({ personId: z.uuid(), email: z.string().max(500) }))
  .handler(({ data }) => run((viewer) => addPersonEmail(db, viewer, data.personId, data.email)))

export const removeEmail = createServerFn({ method: 'POST' })
  .validator(z.object({ personId: z.uuid(), email: z.string().max(500) }))
  .handler(({ data }) => run((viewer) => removePersonEmail(db, viewer, data.personId, data.email)))

export const findAnyPerson = createServerFn({ method: 'GET' })
  .validator(z.object({ q: z.string().max(100) }))
  .handler(({ data }) => run((viewer) => searchAllPeople(db, viewer, data.q)))

export const mergePerson = createServerFn({ method: 'POST' })
  .validator(z.object({ sourceId: z.uuid(), targetId: z.uuid() }))
  .handler(({ data }) => run((viewer) => mergePeople(db, storage, viewer, data)))

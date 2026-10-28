import { getEditableProfile, getProfile, updateProfile } from '@esaf/core'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { rethrowForClient } from '#/server/access.server.ts'
import { db } from '#/server/db.server.ts'
import { getRequestViewer } from '#/server/viewer.server.ts'

// Full validering av feltene skjer i @esaf/core (profileInput). Her sjekkes bare formen.
const profileFields = z.object({
  fullName: z.string(),
  city: z.string(),
  studyBackground: z.string(),
  esCompany: z.string(),
  esCompanyId: z.uuid().nullable(),
  bio: z.string(),
  expertise: z.array(z.string()),
  industries: z.array(z.string()),
  experience: z
    .array(
      z.object({
        companyId: z.uuid().nullable(),
        company: z.string(),
        title: z.string(),
        startYear: z.number().nullable(),
        endYear: z.number().nullable(),
        founder: z.boolean(),
      }),
    )
    .max(50),
  linkedinUrl: z.string(),
  contactEmail: z.string(),
  contactEmailVisible: z.boolean(),
  phone: z.string(),
  phoneVisible: z.boolean(),
})

export type ProfileFormValues = z.infer<typeof profileFields>

export const fetchProfile = createServerFn({ method: 'GET' })
  .validator(z.object({ personId: z.uuid() }))
  .handler(async ({ data }) => {
    try {
      return await getProfile(db, await getRequestViewer(), data.personId)
    } catch (error) {
      return rethrowForClient(error)
    }
  })

export const fetchEditableProfile = createServerFn({ method: 'GET' })
  .validator(z.object({ personId: z.uuid() }))
  .handler(async ({ data }) => {
    try {
      return await getEditableProfile(db, await getRequestViewer(), data.personId)
    } catch (error) {
      return rethrowForClient(error)
    }
  })

export const saveProfile = createServerFn({ method: 'POST' })
  .validator(z.object({ personId: z.uuid(), values: profileFields }))
  .handler(async ({ data }) => {
    try {
      await updateProfile(db, await getRequestViewer(), data.personId, data.values)
    } catch (error) {
      return rethrowForClient(error)
    }
  })

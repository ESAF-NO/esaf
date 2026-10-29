import { loadViewer, type Viewer } from '@esaf/core'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth } from './auth.server.ts'
import { db } from './db.server.ts'

/**
 * Slår opp hvem som står bak forespørselen, ut fra sesjonscookien. Økten tas
 * med, fordi hvordan den ble startet (passkey eller passord) avgjør om
 * adminrettighetene kan brukes.
 */
export async function getRequestViewer(): Promise<Viewer> {
  const session = await auth.api.getSession({ headers: getRequestHeaders() })
  if (!session) return null
  return loadViewer(db, session.user.id, session.session)
}

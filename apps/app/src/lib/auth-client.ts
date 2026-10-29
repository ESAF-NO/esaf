import { passkeyClient } from '@better-auth/passkey/client'
import { twoFactorClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

// Innloggingssiden håndterer tofaktorsteget selv (se /logg-inn), så ingen omdirigering her.
export const authClient = createAuthClient({ plugins: [twoFactorClient(), passkeyClient()] })

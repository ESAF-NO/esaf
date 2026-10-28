# ESAF

Monorepo for ESAF – NTNUs Entreprenørskoles Alumniforening. Det inneholder den offentlige nettsiden for `esaf.no` og grunnmuren til ESAF-appen, en lukket app for godkjente medlemmer.

## Mappestruktur

```
apps/
  site/        Astro. Statisk offentlig landingsside (esaf.no). Ingen server, ingen database.
  app/         TanStack Start + React på Node. Innlogging, medlemskap, adminverktøy.
packages/
  db/          PostgreSQL-skjema (Drizzle), migreringer og databaseklient.
  core/        ESAF-domenet: tilgangsregler, medlemskap og admin-CLI. Brukes av appen og senere MCP.
scripts/       Verktøy for hele repoet (f.eks. sjekk av det statiske bygget).
docker-compose.yml   Lokal Postgres for utvikling.
```

`apps/site` er helt uavhengig av resten og kan bygges og deployes alene. `apps/app` bruker `@esaf/core` og `@esaf/db`. All domenelogikk og tilgangskontroll ligger i `core`, slik at en senere MCP-server kan bruke de samme reglene.

## Kom i gang

Krav: Node 24 (se `.nvmrc`), pnpm via Corepack og Docker.

```sh
corepack enable                 # gir riktig pnpm-versjon fra package.json
pnpm install
cp .env.example .env            # bytt så BETTER_AUTH_SECRET: openssl rand -base64 32
pnpm db:up                      # starter Postgres 18 i Docker (esaf + esaf_test)
pnpm db:migrate                 # kjører migreringer mot DATABASE_URL
pnpm dev                        # site på http://localhost:4321, app på http://localhost:3000
```

Bare én av dem: `pnpm dev:site` (krever ingen database) eller `pnpm dev:app`.

### Kommandoer

| Kommando                      | Hva den gjør                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm dev`                    | Starter site og app i utviklingsmodus                                                           |
| `pnpm build`                  | Produksjonsbygg av begge appene                                                                 |
| `pnpm typecheck`              | `tsc` i alle pakker og `astro check` for siden                                                  |
| `pnpm lint`                   | ESLint og Prettier-sjekk (`pnpm format` retter formatering)                                     |
| `pnpm test`                   | Enhetstester og integrasjonstester mot `TEST_DATABASE_URL`                                      |
| `pnpm verify:site`            | Sjekker at `apps/site/dist` ikke inneholder hemmeligheter, appkode eller ukjente e-postadresser |
| `pnpm db:up` / `pnpm db:down` | Starter eller stopper lokal Postgres                                                            |
| `pnpm db:generate`            | Lager en ny SQL-migrering fra endringer i `packages/db/src/schema.ts`                           |
| `pnpm db:migrate`             | Kjører migreringer mot `DATABASE_URL`                                                           |
| `pnpm db:studio`              | Drizzle Studio mot lokal database                                                               |
| `pnpm admin:grant`            | Gir adminrolle, se «Første admin» under                                                         |
| `pnpm profiles:import`        | Importerer profiler fra kullisten (CSV), se «Profiler og import av kullisten» under             |

Integrasjonstestene hoppes over lokalt hvis `TEST_DATABASE_URL` mangler. I CI må de kjøre. Testene migrerer og tømmer `esaf_test` selv, aldri utviklingsdatabasen.

## Database og migreringer

Skjemaet ligger i `packages/db/src/schema.ts`. Arbeidsflyt for endringer:

1. Endre skjemaet.
2. `pnpm db:generate` lager en SQL-fil i `packages/db/drizzle/`. Les den før du committer den.
3. `pnpm db:migrate` kjører den lokalt.

Appen gjør aldri `drizzle-kit push` eller endrer skjema ved oppstart. I produksjon kjøres `pnpm db:migrate` med produksjonens `DATABASE_URL` som et eget steg før en ny versjon startes. CI feiler hvis skjema og migreringer ikke er i synk.

### Datamodell

| Tabell                                       | Innhold                                                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`, `session`, `account`, `verification` | Better Auth: innloggingsidentitet. Gir ingen tilgang alene.                                                                                                                                                   |
| `person`                                     | En person ESAF kjenner til. Uten `user_id` er det en _profil_ (f.eks. fra kullisten). Med `user_id` har personen selv tatt den i bruk (`claimed_at`). `source` sier om den kom fra registrering eller import. |
| `cohort`                                     | Et kull, identifisert ved opptaksår.                                                                                                                                                                          |
| `person_cohort`                              | Tilknytning mellom person og kull, med type: `student`, `staff` eller `mentor`.                                                                                                                               |
| `membership`                                 | ESAFs avgjørelse om personen: `status` (`pending`/`active`/`inactive`) og `role` (`member`/`admin`).                                                                                                          |
| `audit_event`                                | Revisjonslogg for godkjenninger, admintildelinger, importer og krav på profiler.                                                                                                                              |

**Hvorfor kull er en egen enhet:** Et kull har egne egenskaper (opptaksår, senere kallenavn, syretester, kontaktperson). En person kan ha flere tilknytninger, for eksempel student i ett kull og mentor for et annet. Import, invitasjoner og oversikter skjer dessuten per kull. Et årstall på personen ville ikke dekket noe av dette.

**Hvorfor innlogging ikke gir medlemsinnsyn:** Hvem som helst kan opprette en konto med en vilkårlig e-postadresse. At kontoen finnes, beviser ikke at personen er alumn. Medlemsinnsyn krever derfor bekreftet e-post **og** et aktivt medlemskap som ESAF har godkjent. Det holder rollene og medlemskapet i ESAFs eget domene, ikke i innloggingsleverandøren.

## Profiler og import av kullisten

ESAF kan legge inn alle fra kullisten som **profiler** før de har registrert seg. En profil er en `person` uten konto. Medlemsoversikten viser alle med aktivt medlemskap, og merker hver person tydelig:

- **✓ Verifisert:** personen har registrert seg, bekreftet e-postadressen og tatt i bruk profilen.
- **Profil:** lagt inn av ESAF fra kullisten. Personen har ikke tatt den i bruk ennå.

### Krav på profilen

Når noen registrerer seg og bekrefter en e-postadresse som står på en profil, kobles kontoen automatisk til profilen. Personen arver da kull og medlemskap, og navnet fra kullisten beholdes. Dette skjer bare etter bekreftet e-post, så å registrere seg med andres adresse er ikke nok. Hvert krav logges som `profile.claim`.

Står personen i arket med en gammel adresse (f.eks. studentadresse), blir kontoen ventende. Admin kan da velge **Koble til eksisterende profil** på `/admin`, søke opp riktig profil og koble kontoen. Den tomme personen fra registreringen slettes, og koblingen logges som `profile.link`.

### Import

Eksporter arket fra Google Sheets (Fil → Last ned → Kommaseparerte verdier). Filen bør ikke ligge i repoet. Deretter:

```sh
pnpm profiles:import --fil ~/Downloads/kulliste.csv --kull-er opptak          # forhåndsvisning
pnpm profiles:import --fil ~/Downloads/kulliste.csv --kull-er opptak --apply  # skriver til databasen
```

- **Kolonner:** Navn (eller fornavn og etternavn) og kull er påkrevd. E-post er valgfri, men trengs for automatisk krav. Vanlige overskrifter som «Navn», «Fullt navn», «E-post» og «Kull» kjennes igjen. Andre kan oppgis med `--kolonne navn="…"`, `--kolonne epost="…"` og `--kolonne kull="…"`. Kolonner som ikke brukes, listes i forhåndsvisningen og importeres ikke.
- **Kull:** Det første firesifrede årstallet i cellen brukes. `--kull-er` er påkrevd fordi arket kan bruke enten opptaksår eller uteksamineringsår. Med `uteksaminert` trekkes to år fra, siden programmet er toårig.
- **Forhåndsvisningen** viser antall nye og eksisterende profiler, nye uten e-post, overhoppede rader (manglende navn, ukjent kull, duplikat i filen) og rader å se på (flere e-poster, navneavvik).
- **Idempotent:** Eksisterende personer kjennes igjen på e-post, ellers på navn og kull. De endres ikke, men får kulltilknytningen hvis den mangler. Importen kan derfor kjøres på nytt når arket oppdateres.
- **Medlemsstatus:** Nye profiler får standard `active`, fordi kullisten er ESAFs egen oversikt over hvem som er alumni. Med `--status venter` må hver person i stedet godkjennes etter at de har gjort krav på profilen. Importen gir aldri adminrolle.

**Sikkerhetsavveiing:** Med `active` får den som kontrollerer en e-postadresse i arket medlemsinnsyn ved første innlogging. Er adressene gamle eller usikre, bruk `--status venter`, eller fjern adressene før import.

## Tilgangsgrensen

| Nivå        | Hvem                                                                                       | Ser                                           |
| ----------- | ------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `anonymous` | Ikke innlogget                                                                             | Offentlige sider, innlogging, registrering    |
| `pending`   | Innlogget, men e-post ikke bekreftet eller medlemskap ikke godkjent (`pending`/`inactive`) | Egen statusside (`/venter`)                   |
| `member`    | Bekreftet e-post og `status = active`                                                      | Medlemsoversikt                               |
| `admin`     | Som `member`, og i tillegg `role = admin`                                                  | Godkjenning av ventende medlemskap (`/admin`) |

Regelen ligger i én funksjon, `accessLevel` i `packages/core/src/access.ts`. Den håndheves **på serveren**: alle private data hentes gjennom serverfunksjoner (`apps/app/src/lib/members.functions.ts`). De slår opp sesjonen og kaller `@esaf/core`, som sjekker tilgang ved hvert kall, også etter klientnavigasjon og ved direkte RPC-kall. Rutevaktene i UI-et er bare for brukervennligheten. Vanlige medlemmer får 404 på adminsider.

Adminrolle kan **ikke** gis via registrering, godkjenning eller noe web-endepunkt. Godkjenning setter bare `status`. Better Auths admin-plugin er ikke i bruk, og `user`-tabellen har ikke noe rollefelt.

Testene ligger i `packages/core/test/`. Rene enhetstester dekker alle kombinasjoner av status og rolle. Integrasjonstester mot Postgres dekker uinnlogget og ubekreftet bruker, ventende bruker, medlem uten adminrett, selvgodkjenning og kobling til person fra kulliste.

### Første admin

Det finnes ingen standardbruker og ingen automatisk admin basert på e-postdomene. Første (og senere) admin gis av en operatør med direkte databasetilgang:

1. Personen registrerer seg i appen og bekrefter e-postadressen.
2. Operatøren kjører, med `DATABASE_URL` mot riktig database:
   ```sh
   pnpm admin:grant --email navn@example.com --reason "Styreleder 2026"
   ```
3. Skriptet viser hvilken database det kobler til og krever at e-postadressen skrives inn på nytt. Det nekter å kjøre uten interaktiv terminal, og nekter kontoer med ubekreftet e-post. Tildelingen havner i `audit_event` med begrunnelsen.

### Lokal innlogging

Lokalt sendes ingen e-post. Bekreftelseslenken skrives ut i terminalen der `pnpm dev` kjører («Bekreftelseslenke for …»). Åpne den for å bekrefte kontoen. I produksjon kaster samme kode en feil til en e-postleverandør er satt opp (se under). Da kan ingen kontoer bekreftes, og det finnes ingen vei utenom.

## Sikkerhet i koden

- **Server-only kode:** `apps/app/vite.config.ts` slår på TanStack Starts import protection med `behavior: 'error'`. Klientbundelen kan ikke importere `@esaf/db`, `@esaf/core`, `pg`, `drizzle-orm`, filer i `src/server/` eller `*.server.*`. ESLint har samme regel for rutefilene.
- **Miljøvariabler** valideres med zod i `apps/app/src/server/env.server.ts`. En Nitro-plugin kjører valideringen ved oppstart, så produksjonsserveren stopper med en tydelig feilmelding hvis noe mangler. Produksjon avviser eksempelhemmeligheten fra `.env.example` og `http`-URL-er som ikke peker til localhost.
- **Statisk side:** `pnpm verify:site` (kjøres også i CI) leter i `apps/site/dist` etter database-URL-er, navn på servervariabler, kode fra appen, nøkler og faktiske verdier fra `.env`. Den feiler også på e-postadresser som ikke er satt som `contactEmail` i `apps/site/src/site.config.ts`.
- **Hemmeligheter:** `.env` er gitignorert. `.env.example` inneholder bare ufarlige lokale verdier.

## Deploy

Ingenting er deployet, og CI deployer ikke. DNS for `esaf.no` er ikke endret.

### Nettsiden til Cloudflare Workers Static Assets

`apps/site/wrangler.jsonc` beskriver en Worker uten kode, som bare serverer `apps/site/dist`, med `404.html` for ukjente stier.

```sh
pnpm --filter @esaf/site build
pnpm verify:site
cd apps/site
pnpm exec wrangler login            # én gang, med en konto som har tilgang til ESAF i Cloudflare
pnpm exec wrangler deploy --dry-run # valgfritt: viser hva som lastes opp
pnpm exec wrangler deploy           # publiserer til esaf-site.<konto>.workers.dev
```

For å koble til `esaf.no`: fjern kommentaren rundt `routes` i `wrangler.jsonc` (`{ "pattern": "esaf.no", "custom_domain": true }`) og kjør `wrangler deploy` på nytt. Cloudflare oppretter da DNS-oppføringen og sertifikatet. Dette erstatter det som ligger på `esaf.no` i dag, så det krever en eksplisitt beslutning. Workers Static Assets kan brukes på gratisplanen.

### Appen på Node

`pnpm --filter @esaf/app build` gir en selvstendig Node-server i `apps/app/.output/` (Nitro). Den kjøres slik:

```sh
pnpm db:migrate                      # med produksjonens DATABASE_URL, før oppstart
NODE_ENV=production PORT=3000 \
DATABASE_URL=postgres://… BETTER_AUTH_SECRET=… BETTER_AUTH_URL=https://app.esaf.no \
node apps/app/.output/server/index.mjs
```

Bare `.output/` trengs på serveren. Den kan kopieres til en VPS eller pakkes i et container-image (`node:24-slim`, `COPY .output`, `CMD node .output/server/index.mjs`). Det finnes ingen Dockerfile ennå. Den bør lages og testes når vertsplattformen er valgt. Helsesjekk: `GET /api/health` gir 200 når databasen svarer og 503 ellers.

## Før produksjon

Dette gjenstår før appen kan brukes av medlemmer:

1. **E-postleverandør.** Velg leverandør (f.eks. Resend, Postmark eller SES) og implementer `sendVerificationEmail` i `apps/app/src/server/auth.server.ts`. Legg nøkkelen i miljøet og i env-skjemaet. Legg samtidig til tilbakestilling av passord, som også trenger e-post. Sett opp SPF/DKIM for avsenderdomenet.
2. **Hosting og database.** Velg vert for appen og en administrert eller selvdriftet Postgres. Velg dem samlet, ut fra driftsansvar og kostnad.
3. **Backup.** Automatisk, kryptert backup av Postgres med testet gjenoppretting og avklart lagringstid.
4. **Deploy.** Deploy-jobb for appen, med migrering som eget steg. Bestem `app.esaf.no` og DNS i Cloudflare.
5. **Overvåking.** Oppetidssjekk mot `/api/health`, innsamling av feillogger og varsling til en navngitt person.
6. **Medlemsimport.** Importverktøyet finnes (se over). Det som gjenstår, er å avgjøre hvem som eier og verifiserer kullisten, rydde e-postadressene og kjøre importen mot produksjon.
7. **Personvern.** Behandlingsgrunnlag, personvernerklæring og rutine for sletting.

## Åpne beslutninger

- **Tekst og kontakt på esaf.no:** Teksten bygger på ESAFs partnerpresentasjon fra 2025 og NTNUs studieside. Kontaktadressen er foreningens generelle adresse. Styret må godkjenne formuleringene, bekrefte at aktivitetene fortsatt arrangeres og at adressen kan publiseres. Se `apps/site/KILDER.md`. Logo og bilder fra Drive er ikke tatt i bruk før rettigheter og samtykke er avklart.
- **Hvem skal få medlemsinnsyn:** Alumni, nåværende studenter, ansatte og/eller mentorer? Datamodellen støtter alle fire via `person_cohort.relation`, men godkjenningen skiller ikke mellom dem ennå.
- **Hvilke kolonner fra kullisten som skal inn i appen:** Nå importeres bare navn, e-post og kull. Øvrige felt (f.eks. selskap og telefon) krever egne felt i skjemaet og en beslutning om hvem som får se dem.
- **Medlemsstatus for importerte profiler:** `active` (standard) eller `venter`, se sikkerhetsavveiingen over.
- **Hva medlemmer ser om hverandre:** Medlemsoversikten viser nå bare navn og kull, ikke e-post. Felttilgang må avgjøres før profiler bygges ut.
- **Repo og hosting:** GitHub-reponavn og hosting for appen er ikke valgt.
- **Innlogging:** Nå brukes e-post og passord med e-postbekreftelse. Magisk lenke, passkeys eller Google-innlogging kan legges til når e-post er på plass.
- **MCP:** Ikke implementert. Bygg på `@esaf/core` med den offisielle MCP TypeScript SDK. Better Auths MCP-plugin er i beta og bør testes i en egen integrasjonstest før den velges.

## Versjoner og begrensninger

Versjonene er låst i `pnpm-lock.yaml`. Viktige valg per 28. oktober 2026:

- **TypeScript 6.0**, ikke 7.0. typescript-eslint (`<6.1`) og `@astrojs/check` (`^5 || ^6`) støtter ennå ikke TypeScript 7.
- **Nitro 3** er fortsatt i beta, men det er det TanStack Starts egen mal bruker for Node-hosting. Versjonen er låst eksakt.
- **TanStack Start 1.169.** Serverfunksjoner bruker `.validator()`. Rutefilene genererer `src/routeTree.gen.ts`, som committes.
- **pnpm 12**, **Node 24**, **Postgres 18**, **Astro 7**, **Vite 8**, **Better Auth 1.7**, **Drizzle ORM 0.45**.

# ESAF

Monorepo for ESAF – Entreprenørskolens Alumniforening. Det inneholder den offentlige nettsiden for `esaf.no` og grunnmuren til ESAF-appen, en lukket app for godkjente medlemmer.

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

| Kommando                      | Hva den gjør                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                    | Starter site og app i utviklingsmodus                                                                                                                                                                                                                           |
| `pnpm build`                  | Produksjonsbygg av begge appene                                                                                                                                                                                                                                 |
| `pnpm typecheck`              | `tsc` i alle pakker og `astro check` for siden                                                                                                                                                                                                                  |
| `pnpm lint`                   | ESLint og Prettier-sjekk (`pnpm format` retter formatering)                                                                                                                                                                                                     |
| `pnpm test`                   | Enhetstester og integrasjonstester mot `TEST_DATABASE_URL`                                                                                                                                                                                                      |
| `pnpm verify:site`            | Sjekker at `apps/site/dist` ikke inneholder hemmeligheter, appkode eller ukjente e-postadresser                                                                                                                                                                 |
| `pnpm db:up` / `pnpm db:down` | Starter eller stopper lokal Postgres                                                                                                                                                                                                                            |
| `pnpm db:generate`            | Lager en ny SQL-migrering fra endringer i `packages/db/src/schema.ts`                                                                                                                                                                                           |
| `pnpm db:migrate`             | Kjører migreringer mot `DATABASE_URL`                                                                                                                                                                                                                           |
| `pnpm db:seed`                | Fyller en **lokal** database med oppdiktede alumni, selskaper og innlegg. Sletter alt først, og nekter å kjøre mot noe annet enn localhost. Logg inn som `admin@example.test` / `korrekt-hest-batteri`. Med den ekte lista, se «Lokalt med den ekte kullisten». |
| `pnpm db:studio`              | Drizzle Studio mot lokal database                                                                                                                                                                                                                               |
| `pnpm admin:grant`            | Gir en rolle fra kommandolinjen (standard hovedadmin), se «Første hovedadmin» under                                                                                                                                                                             |
| `pnpm profiles:import`        | Importerer profiler fra kullisten (Excel eller CSV), se «Profiler og import av kullisten» under                                                                                                                                                                 |

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
| `experience`                                 | Hvor personen jobber og har jobbet: selskap, stilling, fra- og til-år og om personen grunnla selskapet. Uten til-år er det nåværende. Den nyeste nåværende vises som stilling under navnet.                   |
| `cohort`                                     | Et kull, identifisert ved uteksamineringsåret, slik ES selv navngir kull: «ES 2024» startet høsten 2022.                                                                                                      |
| `person_cohort`                              | Tilknytning mellom person og kull, med type: `student`, `staff` eller `mentor`.                                                                                                                               |
| `person_email`                               | Alle kjente e-postadresser for en person (registrering, kulliste, NTNU-mail, senere andre kilder). Brukes til å koble en konto til riktig profil. Vises aldri for andre medlemmer.                            |
| `membership`                                 | ESAFs avgjørelse om personen: `status` (`pending`/`active`/`inactive`) og `role` (`member`/`moderator`/`admin`/`owner`).                                                                                      |
| `access_request`                             | Forespørsel om tilgang fra en konto med bekreftet e-post: navn, kull, valgfri LinkedIn og melding, og eventuelt profilen fra kullisten personen sier er dem. Status `open`, `approved` eller `rejected`.      |
| `audit_event`                                | Revisjonslogg: forespørsler, godkjenninger, roller, deaktiveringer, importer, adminredigering og moderering. Skrives aldri over.                                                                              |

**Hvorfor kull er en egen enhet:** Et kull har egne egenskaper (årstall, senere kallenavn, syretester, kontaktperson). En person kan ha flere tilknytninger, for eksempel student i ett kull og mentor for et annet. Import, invitasjoner og oversikter skjer dessuten per kull. Et årstall på personen ville ikke dekket noe av dette.

**Hvorfor uteksamineringsår:** Kullistene, fanene i telefonlista og folk selv bruker uteksamineringsåret. ES 2024 gikk 2022–2024. Profilen viser begge («ES 2024 (2022–2024)»). Migrering `0006` flyttet eksisterende kull fra opptaksår til uteksamineringsår (+2).

**Hvorfor erfaring er en egen tabell:** Én person har ofte jobbet flere steder og startet flere selskaper. Med en liste kan man søke på tidligere arbeidsgivere, og selskapssiden kan vise både gründerselskaper og hvor alumni jobber. Stilling og selskap lå tidligere som to felt på personen. Migrering `0007` flyttet dem over.

**Hvorfor innlogging ikke gir medlemsinnsyn:** Hvem som helst kan opprette en konto med en vilkårlig e-postadresse. At kontoen finnes, beviser ikke at personen er alumn. Medlemsinnsyn krever derfor bekreftet e-post **og** et aktivt medlemskap som en admin har godkjent. Det gjelder også dem som står i kullisten: å kjenne en adresse fra lista gir ingenting, og selv en bekreftet adresse fra lista er bare et sterkt tegn som en admin vurderer. Det holder rollene og medlemskapet i ESAFs eget domene, ikke i innloggingsleverandøren.

## Appen

Appen er bygget etter mønster fra YC Bookface, med Tailwind CSS v4, Inter og Lucide-ikoner. Komponentene ligger i `apps/app/src/components/ui.tsx`. Appen har ingen egen forside, siden den offentlige siden er esaf.no (`apps/site`). `/` sender folk til innlogging, til steget de står på, eller til feeden.

- **Feed** (`/feed`) med kanalene Spørsmål, Intro-forespørsler, Lanseringer, Jobber, Arrangementer og Generelt. Den kan sorteres på populært (stemmer og kommentarer veid mot alder, som Hacker News) eller nyeste. Innlegg kan få stemmer og kommentarer. Forfatteren eller en moderator kan slette.
- **Personer** (`/medlemmer`) er en katalog med søk, kullfilter, filter for verifiserte og de mest brukte emnene og bransjene som snarveier. Søket treffer også tidligere selskaper og stillinger.
- **Kull** (`/kull`) viser alle kull med antall personer og hvor mange som har tatt i bruk profilen. Ditt eget kull er merket, og står også i sidekolonnen på forsiden.
- **Selskaper** (`/selskaper`) viser selskaper startet av alumni, både ES-selskaper (fra «Selskap på Entreprenørskolen») og selskaper noen har grunnlagt (fra erfaring). «Alle selskaper» viser også arbeidsgivere, med hvem som jobber der nå og hvem som har jobbet der.
- **Søk** med ⌘K (eller `/`) finner personer, selskaper og innlegg fra hvor som helst i appen.
- **Forsiden** viser en velkomst med snarveier til profilen, kullet og første innlegg så lenge feeden er tom.
- **Admin** (`/admin`) med fanene Forespørsler, Medlemmer og Logg, se «Roller og rettigheter».
- **Profiler og redigering**, se under.

Ikke bygget ennå: direktemeldinger, varsler, profilbilder, redigering av innlegg, medlemsfordeler og jobber som egen modul. Jobber er foreløpig en kanal i feeden.

## Profiler og katalog

Hver person har en profilside (`/medlemmer/:id`) med erfaring (nåværende og tidligere selskaper, stilling, år og om personen grunnla selskapet), bransjer, by, kull, studieretning før ES, ES-selskap, kort bio, «kan hjelpe med» (opptil 10 emner) og kontaktinfo. «Min profil» i menyen går til din egen.

- **Katalogen** (`/medlemmer`) kan søkes på navn, nåværende og tidligere selskaper og stillinger, bransjer, by, ES-selskap og ekspertise, og filtreres på kull. Søket ligger i URL-en (`?q=…&kull=…`), så det kan deles. Hele katalogen hentes én gang, og filtreringen skjer i nettleseren. Det holder fint for noen tusen personer.
- **Redigering:** Eieren redigerer sin egen profil. Admin kan fylle ut og rette profilfelt for andre, for eksempel profiler fra kullisten. Slike endringer logges som `profile.admin_edit`.
- **Kontaktinfo:** LinkedIn vises når den er fylt ut. E-post og telefon vises bare når personen selv har krysset av for det, og aldri på profiler ingen har tatt i bruk. Admin kan verken se eller endre andres skjulte kontaktinfo. Skjult kontaktinfo filtreres bort på serveren og sendes aldri til nettleseren.
- **Stikkord** (emner og bransjer) med bare små bokstaver får stor forbokstav, så «strategi» og «Strategi» blir samme emne.
- **Validering** ligger i `profileInput` i `@esaf/core`, så MCP senere kan bruke den samme.
- **Profilbilder** er ikke på plass ennå. Initialer vises i stedet. Opplasting krever lagring, for eksempel Cloudflare R2.

## Profiler og import av kullisten

ESAF kan legge inn alle fra kullisten som **profiler** før de har registrert seg. En profil er en `person` uten konto. Medlemsoversikten viser alle med aktivt medlemskap, og merker hver person tydelig:

- **✓ Verifisert:** personen har registrert seg, bekreftet e-postadressen og tatt i bruk profilen.
- **Profil:** lagt inn av ESAF fra kullisten. Personen har ikke tatt den i bruk ennå.

### Veien inn: forespørsel og godkjenning

Ingen får tilgang automatisk. Veien inn er fire steg:

1. **Opprett konto** (`/registrer`) med bare e-post og passord. Siden svarer likt om adressen allerede har en konto, så den kan ikke brukes til å sjekke hvem som er registrert.
2. **Bekreft e-posten.** Det beviser at personen leser den innboksen, ikke bare kjenner adressen.
3. **Hvem er du?** (`/velkommen`). Står kontoens bekreftede adresse på en profil i kullisten, får personen spørsmål om det er dem. Ellers oppgir de navn og kull. Søkere ser aldri andres data, bare profilen med sin egen adresse. LinkedIn og en melding til styret er valgfritt.
4. **En admin godkjenner** (`/admin`). For hver forespørsel vises hva som faktisk er bekreftet. En bekreftet adresse som står på den valgte profilen i kullisten, er et sterkt tegn. Navn, kull, telefon og LinkedIn kan alle med lista skrive inn, så de vises som informasjon, ikke som bevis. Uten sterkt tegn viser kortet profiler med likt navn og telefonnummeret fra lista, så admin kan ringe og spørre. Admin kan koble kontoen til en annen profil, godkjenne den som ny person i oppgitt kull, eller avslå. Avslåtte kan ikke sende på nytt, men må kontakte styret.

Ved godkjenning med profil kobles kontoen til profilen. Personen arver kull, og navnet fra kullisten beholdes. Den tomme personen fra registreringen slettes. Alt logges (`access.request`, `access.approve`, `access.reject`).

**Velkomst etter godkjenning** (`/kom-i-gang`): første gang et nytt medlem kommer inn, får de tre korte steg. Først hva de jobber med, så hva de kan hjelpe med og hvilke bransjer de kjenner. Til slutt om e-post og telefon fra telefonlista skal vises for andre. Alt kan hoppes over.

### Import

Importen leser Excel-fila med telefonlista direkte (`.xlsx`), eller en CSV. Fila inneholder persondata og skal ikke ligge i repoet (`*.csv` er gitignorert; legg `.xlsx` utenfor repoet).

```sh
pnpm profiles:import --fil ~/Downloads/telefonliste.xlsx          # forhåndsvisning
pnpm profiles:import --fil ~/Downloads/telefonliste.xlsx --apply  # skriver til databasen
```

- **Excel:** Hver fane som heter «ES 2024», «ES 2013» osv. er ett kull. Faner som dekker flere år, for eksempel «ES 2005-2009», må ha en kolonne «ES-kull» eller «Kull». Andre faner, som «Mailliste - alle», «Støtteark» og «Klasserepresentanter», hoppes over, og det samme gjelder skjulte faner.
- **Overskrifter:** Overskriftene varierer mellom kullene, og vanlige varianter kjennes igjen: Fornavn/Etternavn/Navn/Name, «E-post (den du bruker!)», «Gmail-adresse», «Primær e-post», «E-mail Address», «NTNU-mail» (lagres som ekstra adresse), Telefon/Mobil/Mobilnr/Mobile Phone, Studieretning/Studiebakgrunn/Profession, LinkedIn, «Spør meg gjerne om» eller «Kompetanseområder» (blir «Kan hjelpe med») og «Bransjer». Mangler første kolonne en gyldig overskrift, tolkes den ut fra nabokolonnene, og forhåndsvisningen sier fra om det.
- **Telefon og e-post** lagres som skjult kontaktinfo på profilen. Ingen andre ser dem før personen selv har tatt i bruk profilen og slått dem på; da er de allerede fylt inn. Numrene ryddes («41234567», «0047 …», «M: +47…» blir «+47 412 34 567»). Står det flere, brukes det første.
- **Importeres aldri:** Facebook, adresse, postnummer, poststed og andre kolonner som ikke er nevnt over. Forhåndsvisningen lister dem per fane.
- **E-post:** Alle gyldige adresser på raden lagres. En konto gjør krav på profilen hvis den registreres med hvilken som helst av dem.
- **LinkedIn:** Delingslenker blir ryddet opp (`?utm_…` og undersider fjernes). Lenker som ikke går til en profil, hoppes over med et varsel.
- **Profilfelt i CSV:** By og LinkedIn kjennes igjen automatisk. Selskap, stilling og ES-selskap må oppgis eksplisitt, fordi «Selskap» kan bety begge deler: `--kolonne selskap="Arbeidsgiver" --kolonne stilling="Jobb" --kolonne es-selskap="ES-selskap"`.
- **Kull:** Årstallet kommer fra fanenavnet eller kullkolonnen, og er uteksamineringsåret slik ES bruker det. Har en kilde opptaksår i stedet, bruk `--kull-er opptak`; da legges to år til. En kullcelle som «2005/2006» kobler personen til begge kull.
- **Samme person flere steder:** Står samme navn og e-post i to faner, kobles personen til begge kull. Samme e-post med et annet navn hoppes over. Rader uten kull tas med hvis de har e-post (så de kjennes igjen neste gang), ellers hoppes de over.
- **Forhåndsvisningen** viser hvilke kolonner som brukes per fane, antall nye og eksisterende profiler, rader som hoppes over (manglende navn, ukjent kull, duplikat på tvers av faner) og rader å se på. Navn vises bare der du må finne raden i arket. `--vis-rader` lister alle rader.
- **Idempotent og berikbar:** Personer kjennes igjen på hvilken som helst kjent e-post, ellers på navn og kull. Ved ny import eller import fra en annen kilde fylles bare tomme felt, og bare på profiler ingen har tatt i bruk. Det gjelder også telefon, bransjer og stilling. Nye e-postadresser legges til. Navn og alt en person selv har skrevet, overskrives aldri.
- **Medlemsstatus:** Nye profiler får standard `active`, så de vises i katalogen for medlemmer. Med `--status venter` vises de ikke før personen er godkjent. Uansett status gir importen aldri tilgang til noen konto (se «Veien inn»), og aldri adminrolle.

### Lokalt med den ekte kullisten

```sh
pnpm db:seed --fil ~/Downloads/telefonliste.xlsx --admin deg@example.com
```

Tømmer den **lokale** databasen og importerer lista med samme kode som `profiles:import`. Med `--admin` får du en innlogging med den e-posten du står med i lista (passord `korrekt-hest-batteri`). Kontoen går samme vei som en ekte bruker: forespørsel om å være profilen med den adressen, som operatøren godkjenner med adminrolle. Første innlogging viser velkomststegene. Det lages ingen innlegg, så ingen ekte personer får tekst de ikke har skrevet. Fila leses bare og havner aldri i repoet.

Uten `--fil` lager `pnpm db:seed` oppdiktede data, inkludert to åpne forespørsler på `/admin`: Kari Nordmann (adressen står på profilen) og Nils Nyregistrert (ikke funnet i lista). De logger inn med `kari@example.test` og `nils@example.test`.

## Tilgangsgrensen

| Nivå        | Hvem                                                                                       | Ser                                                |
| ----------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `anonymous` | Ikke innlogget                                                                             | Offentlige sider, innlogging, registrering         |
| `pending`   | Innlogget, men e-post ikke bekreftet eller medlemskap ikke godkjent (`pending`/`inactive`) | «Hvem er du?» (`/velkommen`) og status (`/venter`) |
| `member`    | Bekreftet e-post og `status = active`                                                      | Appen, og det rollen gir i tillegg (se under)      |

Regelen ligger i én funksjon, `accessLevel` i `packages/core/src/access.ts`. Den håndheves **på serveren**: alle private data hentes gjennom serverfunksjoner (`apps/app/src/lib/*.functions.ts`). De slår opp sesjonen og kaller `@esaf/core`, som sjekker tilgang ved hvert kall, også etter klientnavigasjon og ved direkte RPC-kall. Rutevaktene i UI-et er bare for brukervennligheten. Den som mangler rettigheten, får 404 på adminsider.

### Roller og rettigheter

Et aktivt medlem har én rolle. En rolle har alt rollene under den har. Hva hver rolle får, står i `permissions` i `packages/core/src/access.ts`, og hver handling sjekker rettigheten på serveren.

| Rettighet          | Hva den gir                                                          | Moderator | Admin | Hovedadmin |
| ------------------ | -------------------------------------------------------------------- | :-------: | :---: | :--------: |
| `content.moderate` | Fjerne andres innlegg og kommentarer                                 |     ✓     |   ✓   |     ✓      |
| `members.review`   | Behandle forespørsler om tilgang og koble kontoer til profiler       |           |   ✓   |     ✓      |
| `members.manage`   | Deaktivere og gjenopprette medlemmer (se under om admins)            |           |   ✓   |     ✓      |
| `profiles.edit`    | Rette andres profiler, men aldri kontaktinfo                         |           |   ✓   |     ✓      |
| `audit.read`       | Lese revisjonsloggen                                                 |           |   ✓   |     ✓      |
| `roles.manage`     | Gi og fjerne roller, og endre tilgangen til admins og hovedadmins    |           |       |     ✓      |
| Tofaktor påkrevd   | Uten tofaktor kan rollen ikke brukes; adminsidene sender til oppsett |           |   ✓   |     ✓      |

Vanlige medlemmer (`member`) har ingen av rettighetene. `owner` heter «hovedadmin» i appen.

- **Tofaktor:** Admins og hovedadmins må slå på tofaktor (autentiseringsapp) under «Konto og sikkerhet» før rettighetene virker. Uten det sender `/admin` dit, og serveren svarer `two_factor_required`.
- **Roller gis i appen** av en hovedadmin under Admin → Medlemmer, med valgfri begrunnelse. Ingen kan endre sin egen rolle, og det finnes alltid minst én aktiv hovedadmin. Registrering og godkjenning gir aldri rolle; godkjenning setter bare `status`. Better Auths admin-plugin er ikke i bruk, og `user`-tabellen har ikke noe rollefelt.
- **Deaktivering** (Admin → Medlemmer) krever begrunnelse. Personen logges ut på alle enheter med en gang (øktene slettes), mister tilgangen og vises ikke lenger i katalogen. Rollen settes tilbake til medlem, så rettigheter må gis på nytt om tilgangen gjenopprettes. Admins kan deaktivere og gjenopprette medlemmer og moderatorer; bare en hovedadmin kan endre tilgangen til admins og hovedadmins. Ingen kan deaktivere seg selv.
- **Revisjonsloggen** (Admin → Logg) viser hvem som gjorde hva, nyeste først, med begrunnelsen når den finnes. Den dekker forespørsler og godkjenninger (`access.*`, `membership.*`), roller (`role.change`, `operator.grant_role`), import (`operator.import_profiles`), adminredigering og kobling av profiler (`profile.admin_edit`, `profile.link`) og moderering (`content.remove_post`, `content.remove_comment`). Hendelser uten utfører kommer fra en operatør på kommandolinjen. Loggen kan ikke endres i appen.

Testene ligger i `packages/core/test/`. Rene enhetstester dekker alle kombinasjoner av status og rolle. Integrasjonstester mot Postgres dekker uinnlogget og ubekreftet bruker, ventende bruker, medlem uten rettigheter, selvgodkjenning, at en bekreftet adresse fra kullisten ikke gir tilgang alene, at søkere ikke kan velge andres profil, godkjenning med og uten profil, avslag, operatørens rolletildeling, rolleendringer, tofaktorkravet, deaktivering og revisjonsloggen.

### Første hovedadmin

Det finnes ingen standardbruker og ingen automatisk admin basert på e-postdomene. Den første hovedadmin gis av en operatør med direkte databasetilgang. Etter det gir hovedadmins roller i appen.

1. Personen registrerer seg i appen, bekrefter e-postadressen og svarer på «Hvem er du?».
2. Operatøren kjører, med `DATABASE_URL` mot riktig database. Det godkjenner forespørselen (og kobler kontoen til profilen personen valgte fra kullisten) og gir rollen hovedadmin:
   ```sh
   pnpm admin:grant --email navn@example.com --reason "Styreleder 2026"
   pnpm admin:grant --email navn@example.com --reason "…" --rolle admin   # eller moderator
   ```
3. Skriptet viser hvilken database det kobler til og krever at e-postadressen skrives inn på nytt. Det nekter å kjøre uten interaktiv terminal, og nekter kontoer med ubekreftet e-post. Tildelingen havner i revisjonsloggen med begrunnelsen.
4. Personen slår på tofaktor under «Konto og sikkerhet». Før det virker ikke adminrettighetene.

### Lokal innlogging

Lokalt sendes ingen e-post. Bekreftelseslenken skrives ut i terminalen der `pnpm dev` kjører («Bekreftelseslenke for …»). Åpne den for å bekrefte kontoen. Da logges du inn og havner på «Hvem er du?». I produksjon kaster samme kode en feil til en e-postleverandør er satt opp (se under). Da kan ingen kontoer bekreftes, og det finnes ingen vei utenom.

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
- **Telefonnumrene fra lista:** De er importert, men vises ikke før personen selv slår dem på. Lista ble delt for at ES-ere skulle kunne ringe hverandre, så styret kan velge å vise numrene for godkjente medlemmer fra start, med mulighet til å skjule dem. Det er én endring i `getProfile`.
- **Medlemsstatus for importerte profiler:** `active` (standard) eller `venter`, se sikkerhetsavveiingen over.
- **Hva medlemmer ser om hverandre:** Alle profilfelt er synlige for aktive medlemmer. E-post og telefon vises bare når personen selv slår det på.
- **Repo og hosting:** GitHub-reponavn og hosting for appen er ikke valgt.
- **Innlogging:** Nå brukes e-post og passord med e-postbekreftelse. Magisk lenke, passkeys eller Google-innlogging kan legges til når e-post er på plass.
- **MCP:** Ikke implementert. Bygg på `@esaf/core` med den offisielle MCP TypeScript SDK. Better Auths MCP-plugin er i beta og bør testes i en egen integrasjonstest før den velges.

## Versjoner og begrensninger

Versjonene er låst i `pnpm-lock.yaml`. Viktige valg per 28. oktober 2026:

- **TypeScript 6.0**, ikke 7.0. typescript-eslint (`<6.1`) og `@astrojs/check` (`^5 || ^6`) støtter ennå ikke TypeScript 7.
- **Nitro 3** er fortsatt i beta, men det er det TanStack Starts egen mal bruker for Node-hosting. Versjonen er låst eksakt.
- **TanStack Start 1.169.** Serverfunksjoner bruker `.validator()`. Rutefilene genererer `src/routeTree.gen.ts`, som committes.
- **pnpm 12**, **Node 24**, **Postgres 18**, **Astro 7**, **Vite 8**, **Better Auth 1.7**, **Drizzle ORM 0.45**.

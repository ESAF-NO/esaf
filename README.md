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

Appen gjør aldri `drizzle-kit push` eller endrer skjema ved oppstart. I produksjon kjører containeren migreringene før serveren starter (se «Appen med Coolify»). CI feiler hvis skjema og migreringer ikke er i synk.

### Datamodell

| Tabell                                       | Innhold                                                                                                                                                                                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`, `session`, `account`, `verification` | Better Auth: innloggingsidentitet. Gir ingen tilgang alene.                                                                                                                                                                                                          |
| `person`                                     | En person ESAF kjenner til. Uten `user_id` er det en _profil_ (f.eks. fra kullisten). Med `user_id` har personen selv tatt den i bruk (`claimed_at`). `source` sier om den kom fra registrering eller import.                                                        |
| `experience`                                 | Hvor personen jobber og har jobbet: selskap (`company_id`), stilling, fra- og til-år og om personen grunnla selskapet. Uten til-år er det nåværende. Den nyeste nåværende vises som stilling under navnet.                                                           |
| `company`                                    | Et selskap: unik `slug` (følger navnet), navn, kort beskrivelse, «om selskapet», nettside, grunnlagt, sted, bransjer og status (`active`/`acquired`/`closed`). `alias_slugs` er tidligere slugger og sammenslåtte duplikater. `person.es_company_id` peker også hit. |
| `cohort`                                     | Et kull, identifisert ved uteksamineringsåret, slik ES selv navngir kull: «ES 2024» startet høsten 2022.                                                                                                                                                             |
| `person_cohort`                              | Tilknytning mellom person og kull, med type: `student`, `staff` eller `mentor`.                                                                                                                                                                                      |
| `person_email`                               | Alle kjente e-postadresser for en person (registrering, kulliste, NTNU-mail, senere andre kilder). Brukes til å koble en konto til riktig profil. Vises aldri for andre medlemmer.                                                                                   |
| `membership`                                 | ESAFs avgjørelse om personen: `status` (`pending`/`active`/`inactive`) og `role` (`member`/`moderator`/`admin`/`owner`).                                                                                                                                             |
| `access_request`                             | Forespørsel om tilgang fra en konto med bekreftet e-post: navn, kull, valgfri LinkedIn og melding, og eventuelt profilen fra kullisten personen sier er dem. Status `open`, `approved` eller `rejected`.                                                             |
| `audit_event`                                | Revisjonslogg: forespørsler, godkjenninger, roller, deaktiveringer, importer, adminredigering og moderering. Skrives aldri over.                                                                                                                                     |
| `post`, `comment`, `post_vote`               | Feeden. Tekst i Markdown. `edited_at` settes når forfatteren endrer innholdet, `pinned_at` når en moderator fester et innlegg, og `deleted_at` skjuler innhold uten å slette det.                                                                                    |
| `notification`                               | Varsler til ett medlem: type, hvem som utløste det, innlegget og kommentaren det gjelder, `read_at` og `emailed_at`. Unik `event_key` per mottaker hindrer doble varsler.                                                                                            |

**Hvorfor kull er en egen enhet:** Et kull har egne egenskaper (årstall, senere kallenavn, syretester, kontaktperson). En person kan ha flere tilknytninger, for eksempel student i ett kull og mentor for et annet. Import, invitasjoner og oversikter skjer dessuten per kull. Et årstall på personen ville ikke dekket noe av dette.

**Hvorfor uteksamineringsår:** Kullistene, fanene i telefonlista og folk selv bruker uteksamineringsåret. ES 2024 gikk 2022–2024. Profilen viser begge («ES 2024 (2022–2024)»). Migrering `0006` flyttet eksisterende kull fra opptaksår til uteksamineringsår (+2).

**Hvorfor selskap er en egen tabell:** Med selskapet som fritekst ble «Kahoot!» og «kahoot» to ting, og det fantes ikke noe sted å skrive hva selskapet gjør. Nå peker erfaring og ES-selskap på et `company`, så info skrives én gang og vises for alle. Migrering `0010` laget selskapene fra navnene som fantes: navn med samme slug ble ett selskap, og skrivemåten som var brukt flest ganger ble navnet. SQL-funksjonen `company_slug` i databasen er samme regel som `companySlug` i `@esaf/core`, og en test sjekker at de gir samme svar.

**Hvorfor erfaring er en egen tabell:** Én person har ofte jobbet flere steder og startet flere selskaper. Med en liste kan man søke på tidligere arbeidsgivere, og selskapssiden kan vise både gründerselskaper og hvor alumni jobber. Stilling og selskap lå tidligere som to felt på personen. Migrering `0007` flyttet dem over.

**Hvorfor innlogging ikke gir medlemsinnsyn:** Hvem som helst kan opprette en konto med en vilkårlig e-postadresse. At kontoen finnes, beviser ikke at personen er alumn. Medlemsinnsyn krever derfor bekreftet e-post **og** et aktivt medlemskap som en admin har godkjent. Det gjelder også dem som står i kullisten: å kjenne en adresse fra lista gir ingenting, og selv en bekreftet adresse fra lista er bare et sterkt tegn som en admin vurderer. Det holder rollene og medlemskapet i ESAFs eget domene, ikke i innloggingsleverandøren.

## Appen

Appen er bygget etter mønster fra YC Bookface, med Tailwind CSS v4, Inter og Lucide-ikoner. Komponentene ligger i `apps/app/src/components/ui.tsx`. Appen har ingen egen forside, siden den offentlige siden er esaf.no (`apps/site`). `/` sender folk til innlogging, til steget de står på, eller til feeden.

- **Feed** (`/feed`) med kanalene Spørsmål, Intro-forespørsler, Lanseringer, Jobber, Arrangementer og Generelt. Den kan sorteres på populært (stemmer og kommentarer veid mot alder, som Hacker News) eller nyeste. Innlegg kan få stemmer og kommentarer. Forfatteren kan slette, og moderatorer kan fjerne andres innhold (logges).
- **Redigering:** Forfatteren kan redigere innlegget sitt (`/feed/:id/rediger`: kanal, tittel, tekst og lenke) og kommentarene sine. Da vises «redigert» med tidspunkt. Ingen andre kan redigere, heller ikke moderatorer og admins. De kan bare fjerne. Lagres uten endringer, merkes ingenting som redigert.
- **Markdown** i innlegg og kommentarer: avsnitt og linjeskift, **fet**, _kursiv_, lenker (også nakne adresser), lister, kode, kodeblokker og sitater. Skrivefeltene har «Skriv» og «Forhåndsvis» og en linje med formateringshjelp. Teksten vises med `react-markdown` og `remark-gfm` som React-elementer, aldri som HTML-streng: rå HTML vises som tekst, bare `http(s)`- og `mailto`-lenker beholdes (med `rel="noopener noreferrer nofollow ugc"`), og bilder blir lenker, så eksterne bilder aldri lastes. Utdragene i feeden lages som ren tekst i `@esaf/core` (`markdownToPlainText`). Omtaler skrevet som `@[Navn](personId)` vises som lenke til profilen; `Markdown` tar `renderMention` for å vise dem annerledes.
- **Festede innlegg:** Moderatorer og oppover (admins med tofaktor) kan feste og løsne innlegg. Festede innlegg står øverst i «Hjem» og i kanalen sin, sist festet først, merket «Festet». I søk, på profiler og på kullsider vises innleggene i vanlig rekkefølge. Festing og løsning logges (`content.pin_post`, `content.unpin_post`).
- **Varsler og omtaler**, se under.
- **Personer** (`/medlemmer`) er en katalog med søk, kullfilter, filter for verifiserte og de mest brukte emnene og bransjene som snarveier. Søket treffer også tidligere selskaper og stillinger.
- **Kull** (`/kull`) viser alle kull med antall personer og hvor mange som har tatt i bruk profilen. Ditt eget kull er merket, og står også i sidekolonnen på forsiden. Hvert kull har en egen side (`/kull/2024` for ES 2024, som gikk 2022–2024) med personene, selskapene folk i kullet har grunnlagt eller hadde på ES, og de nyeste innleggene deres. Mentorer og ansatte vises for seg. Kullet på profiler og «Ditt kull» på forsiden lenker hit, og «Søk i kullet» går til katalogen filtrert på kullet. Ukjente årstall gir 404.
- **Selskaper** (`/selskaper`) viser selskaper startet av alumni, både ES-selskaper (fra «Selskap på Entreprenørskolen») og selskaper noen har grunnlagt (fra erfaring). «Alle selskaper» viser også arbeidsgivere. Oversikten kan søkes og filtreres på bransje (`?q=…&bransje=…`). Hvert selskap har en egen side (`/selskaper/:slug`), se «Selskaper» under.
- **Søk** med ⌘K (eller `/`) finner personer, selskaper og innlegg fra hvor som helst i appen.
- **Forsiden** viser en velkomst med snarveier til profilen, kullet og første innlegg så lenge feeden er tom.
- **Admin** (`/admin`) med fanene Forespørsler, Medlemmer og Logg, se «Roller og rettigheter».
- **Profiler og redigering**, se under.

Ikke bygget ennå: direktemeldinger, varsler på e-post, medlemsfordeler og jobber som egen modul. Jobber er foreløpig en kanal i feeden.

### Varsler og omtaler

Klokka i toppen viser antall uleste varsler og de siste varslene. Et klikk åpner innlegget eller kommentaren og merker varselet som lest. `/varsler` viser alle, delt i i dag og tidligere, med «Merk alle som lest».

- **Hvem får varsel:** forfatteren når noen kommenterer innlegget, alle som har kommentert et innlegg når noen kommenterer det igjen, den som blir nevnt med @ i et innlegg eller en kommentar, den som blir godkjent (velkomst), og de fra samme kull når noen fra kullet blir godkjent.
- **Reglene** ligger i `packages/core/src/notifications.ts`: ingen får varsel om noe de selv gjorde, bare aktive medlemmer med egen konto får varsler, og én hendelse gir høyst ett varsel per person (unik `event_key` per mottaker). Nevner en kommentar forfatteren av innlegget, blir det ett varsel om omtalen. Varslene lages i samme transaksjon som kommentaren, innlegget eller godkjenningen.
- **Slettet innhold:** varsler om slettede innlegg og kommentarer skjules og telles ikke som uleste. Tittel og utdrag hentes når varselet vises, så de alltid er oppdatert.
- **Lest:** å åpne et varsel om et innlegg merker alle varslene om det innlegget som lest, siden siden viser alle kommentarene. Man ser og endrer bare sine egne varsler.
- **Antall uleste** kommer med fra serveren ved hver navigering, og hentes på nytt hvert minutt mens fanen er synlig og når den blir synlig igjen. Ingen websockets.
- **Omtaler:** skriv @ i et innlegg eller en kommentar for å få forslag. Lista styres med piltastene, Enter eller Tab velger, Esc lukker. Teksten lagres med `@[Kari Nordmann](<personId>)`, og vises som en lenke til profilen (bygget med React, aldri som HTML). Serveren skriver om alle omtaler før lagring: aktive medlemmer med konto får navnet fra profilen, alle andre blir vanlig tekst uten lenke og uten varsel. Maks 20 personer per tekst.
- **E-post:** `notification.emailed_at` er klar for en senere e-postoppsummering av uleste varsler.

## Profiler og katalog

Hver person har en profilside (`/medlemmer/:id`) med erfaring (nåværende og tidligere selskaper, stilling, år og om personen grunnla selskapet), bransjer, by, kull, studieretning før ES, ES-selskap, kort bio, «kan hjelpe med» (opptil 10 emner) og kontaktinfo. «Min profil» i menyen går til din egen.

- **Katalogen** (`/medlemmer`) kan søkes på navn, nåværende og tidligere selskaper og stillinger, bransjer, by, ES-selskap og ekspertise, og filtreres på kull. Søket ligger i URL-en (`?q=…&kull=…`), så det kan deles. Hele katalogen hentes én gang, og filtreringen skjer i nettleseren. Det holder fint for noen tusen personer.
- **Redigering:** Eieren redigerer sin egen profil. Admin kan fylle ut og rette profilfelt for andre, for eksempel profiler fra kullisten. Slike endringer logges som `profile.admin_edit`.
- **Kontaktinfo:** LinkedIn vises når den er fylt ut. E-post og telefon vises bare når personen selv har krysset av for det, og aldri på profiler ingen har tatt i bruk. Admin kan verken se eller endre andres skjulte kontaktinfo. Skjult kontaktinfo filtreres bort på serveren og sendes aldri til nettleseren.
- **Stikkord** (emner og bransjer) med bare små bokstaver får stor forbokstav, så «strategi» og «Strategi» blir samme emne.
- **Validering** ligger i `profileInput` i `@esaf/core`, så MCP senere kan bruke den samme.
- **Profilbilder:** se under. Uten bilde vises initialer.

## Profilbilder

Medlemmer laster opp, bytter og fjerner sitt eget bilde under «Rediger profil» (og i siste velkomststeg). Admins med `profiles.edit` kan gjøre det samme for aktive medlemmer og profiler fra kullisten, og fjerne hvem som helst sitt bilde. Det logges som `profile.admin_photo_upload` og `profile.admin_photo_remove`. Reglene ligger i `packages/core/src/photos.ts`.

- **Behandling:** JPEG, PNG og WebP opptil 10 MB. Filtypen avgjøres av innholdet, ikke filnavn eller MIME-type, og bildebiblioteket (sharp) har bare dekoderne for disse tre slått på. Bildet roteres etter EXIF, all metadata fjernes (EXIF med GPS, XMP, IPTC og fargeprofil), det beskjæres til kvadrat fra midten og lagres som WebP i 512 og 192 piksler. Bilder under 128 piksler eller over 100 megapiksler avvises.
- **Nøkler:** Hvert bilde får en ny tilfeldig nøkkel (`person.photo_key`), og de gamle filene slettes når bildet byttes eller fjernes. Feiler slettingen, logges det, og fila serveres uansett ikke lenger.
- **Visning:** `GET /api/bilder/<nøkkel>-<størrelse>.webp` krever aktivt medlemskap (401 uten innlogging, 404 for ukjente eller utgåtte nøkler) og svarer med `Cache-Control: private, max-age=31536000, immutable`. Bøtta skal aldri være offentlig.
- **Opplasting:** `PUT` og `DELETE` på `/api/medlemmer/<personId>/bilde`, med bildet som body. Størrelse og tilgang sjekkes før fila leses inn, og forespørsler fra andre nettsteder avvises.

| Variabel                                                               | Hva                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | S3-kompatibel lagring, f.eks. Cloudflare R2 (`https://<konto-id>.r2.cloudflarestorage.com`). Alle eller ingen. Påkrevd i produksjon. |
| `S3_REGION`                                                            | Valgfri, standard `auto` (R2).                                                                                                       |
| `UPLOAD_DIR`                                                           | Bare utvikling: mappe for bildene når S3 ikke er satt. Standard `.data/uploads` i roten av repoet (gitignorert).                     |

Produksjonsserveren starter ikke uten S3-variablene; det er ingen stille overgang til disk. For R2: lag en privat bøtte og et API-token med «Object Read & Write» for bare den bøtta.

## Selskaper

Selskapssiden (`/selskaper/:slug`) viser navn, kort beskrivelse, status (aktiv, oppkjøpt, nedlagt), nettside, grunnlagt, sted, bransjer og «om selskapet». Under «Fra ES» står gründerne, ES-teamet (med kull), de som jobber der nå og de som har jobbet der, med stilling og år, og lenker til profilene. Bare aktive medlemmer vises.

- **Redigering:** Gründere (også tidligere), ES-teamet og de som jobber der nå kan redigere selskapsinfoen, og admins med `profiles.edit`. Tidligere ansatte og andre medlemmer kan ikke. Admins som ikke selv er knyttet til selskapet, logges som `company.admin_edit`. Validering ligger i `companyInput` i `@esaf/core`; nettsider må være http eller https.
- **Nytt navn** gir ny slug. Den gamle blir et alias, så gamle lenker sendes videre og den gamle skrivemåten kobles fortsatt til selskapet. Et navn som tilhører et annet selskap, avvises.
- **Erfaring:** Selskapsfeltet i profilen og velkomststegene foreslår selskaper som finnes mens man skriver. Et valgt forslag kobles på id. Skriver man et navn, kobles det til selskapet med samme slug («kahoot» blir «Kahoot!»), ellers blir det et nytt selskap. Et selskap som bare ble laget fra et navn og som ingen lenger er knyttet til (for eksempel en rettet skrivefeil), ryddes bort. Importen fra kullisten kobler selskaper på samme måte.
- **Duplikater:** «Statkraft AS» og «Statkraft» er to slugger. Forslagene viser «Statkraft» når man skriver «Statkraft AS», og en admin kan slå dem sammen nederst på redigeringssiden. Erfaring og ES-team flyttes, tomme felt fylles fra duplikatet, og duplikatets slug blir et alias. Logges som `company.merge`.
- **Søk:** ⌘K finner selskaper uansett skrivemåte og går til selskapssiden.

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

Uten `--fil` lager `pnpm db:seed` oppdiktede data, inkludert to åpne forespørsler på `/admin`: Kari Nordmann (adressen står på profilen) og Nils Nyregistrert (ikke funnet i lista). De logger inn med `kari@example.test` og `nils@example.test`. `sara@example.test` er et vanlig medlem, så varsler og omtaler kan prøves med to brukere. Ada har allerede to varsler fra henne.

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

Nettsiden ligger på https://esaf.no og deployes automatisk til Cloudflare fra GitHub Actions. Appen deployes med Coolify til en egen server (se under). `esaf.no` ligger i ESAFs Cloudflare-konto, der Email Routing også er slått på for å videresende `styret@esaf.no` til foreningens Gmail.

### Nettsiden til Cloudflare Workers Static Assets

`apps/site/wrangler.jsonc` beskriver en Worker uten kode, som bare serverer `apps/site/dist`, med `404.html` for ukjente stier. Workers Static Assets kan brukes på gratisplanen.

**Automatisk deploy.** Jobben `deploy-site` i `.github/workflows/ci.yml` kjører ved push til `main`, etter at lint, typesjekk, tester, bygg og `verify:site` har gått gjennom. Den bygger nettsiden på nytt, kjører `verify:site` på akkurat de filene som publiseres, og kjører `wrangler deploy`. PR-er deployer aldri, men CI sjekker Cloudflare-oppsettet med `wrangler deploy --dry-run`, som ikke trenger innlogging. For å deploye `main` på nytt uten ny commit: `gh workflow run CI --ref main`.

Slik er deployen sikret:

- API-nøkkelen er en hemmelighet i GitHub-miljøet `production`. Bare jobber på `main` får bruke miljøet, og administratorer kan ikke overstyre det. PR-er og forks får aldri nøkkelen.
- Nøkkelen har bare rettigheten «Workers Scripts: Edit» i ESAFs Cloudflare-konto. Det dekker også egne domener.
- Deploy-jobben installerer bare nettsiden og verktøyene i roten, ikke appen og databasepakkene. pnpm kjører bare installasjonsskript for pakkene i `allowBuilds`.
- Handlingene i arbeidsflyten er låst til commit-SHA. Dependabot foreslår oppdateringer månedlig, tidligst en uke etter at en ny versjon er sluppet.

**Oppsett, én gang.** Krever tilgang til ESAFs Cloudflare-konto.

1. Cloudflare: Manage Account → Account API Tokens → Create Token → Custom token. Gi den navnet `github-actions-esaf-site`, rettigheten Account · Workers Scripts · Edit og bare ESAF-kontoen under Account Resources. Bruk en kontoeid nøkkel, ikke en personlig, så den virker videre når styret byttes ut.
2. `gh secret set CLOUDFLARE_API_TOKEN --env production --repo ESAF-NO/esaf` og lim inn nøkkelen når du blir spurt.
3. `gh variable set CLOUDFLARE_ACCOUNT_ID --repo ESAF-NO/esaf --body <konto-ID>`. Konto-ID-en står på kontoens oversiktsside i Cloudflare. Variabelen slår på deploy-jobben, som hoppes over så lenge den mangler. Derfor hoppes den også over i forks.
4. `gh workflow run CI --ref main` starter en deploy uten ny commit.

For å bytte nøkkel: lag en ny, kjør steg 2 på nytt, start en deploy og slett den gamle nøkkelen i Cloudflare.

**Domener.** `esaf.no` og `www.esaf.no` er egne domener for Workeren i `wrangler.jsonc`, så Cloudflare lager DNS-oppføringene og sertifikatene ved deploy. `workers.dev` og forhåndsvisnings-URL-er er slått av, så siden bare ligger på `esaf.no`. To innstillinger ligger i Cloudflare og ikke i koden, fordi deploy-nøkkelen ikke har tilgang til dem:

- Redirect Rule `www til esaf.no` sender `www.esaf.no` videre til `https://esaf.no` med 301 og beholder sti og spørrestreng.
- Always Use HTTPS (SSL/TLS → Edge Certificates) sender `http://` videre til `https://`.

Sikkerhetsoverskriftene, blant annet HSTS, settes i `apps/site/public/_headers`.

**Manuell deploy**, hvis CI ikke kan brukes:

```sh
pnpm --filter @esaf/site build
pnpm verify:site
cd apps/site
pnpm exec wrangler login            # med en konto som har tilgang til ESAF i Cloudflare
pnpm exec wrangler deploy --dry-run # valgfritt: viser hva som lastes opp
pnpm exec wrangler deploy
```

### Appen med Coolify

Appen og Postgres kjører på en Hetzner-server i Tyskland, styrt av Coolify. Coolify bygger `apps/app/Dockerfile` på serveren ved push til `main`.

**Flyten.** En endring går via PR. CI («Sjekk og bygg») må være grønn før PR-en kan merges, og `main` er beskyttet mot direkte push. Coolify deployer det som havner på `main`. Testene i Actions stopper ikke en deploy alene; det er kravet om grønn CI før merge som gjør det.

**Ved hver deploy** bygger Coolify bildet og starter en ny container. Containeren kjører migreringene og starter så serveren. Feiler migreringen eller helsesjekken (`GET /api/health`, 200 når databasen svarer), tar ikke den nye containeren over, og den forrige kjører videre. Migreringer rulles ikke tilbake. Lag dem derfor slik at også forrige versjon av appen tåler dem: legg til kolonner og tabeller i én deploy, og fjern gamle i en senere.

**Oppsett i Coolify** (én gang):

1. **Postgres:** ny ressurs, Postgres 18, ikke offentlig tilgjengelig. Databasen nås bare fra appen over Coolifys interne nettverk.
2. **Appen:** ny ressurs fra GitHub-repoet, gren `main`, byggetype Dockerfile, basemappe `/`, Dockerfile `apps/app/Dockerfile`, port `3000`. Slå på automatisk deploy.
3. **Miljøvariabler** på appen: `DATABASE_URL` (den interne URL-en fra Postgres-ressursen), `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), `BETTER_AUTH_URL=https://app.esaf.no` og S3-variablene for R2 (se «Profilbilder»). `NODE_ENV` og `PORT` er satt i bildet.
4. **Domene:** `https://app.esaf.no` på appen, med DNS satt opp på samme måte som de andre domenene på serveren.
5. **Backup:** planlagt backup av Postgres-ressursen til S3-lagring utenfor serveren (en egen privat R2-bøtte), daglig. Gjenopprett én gang til en ny database for å se at det virker.

**Verktøy i produksjon.** Bildet har hele arbeidsområdet, så kommandoene fra «Kommandoer» kan kjøres i appens terminal i Coolify, for eksempel `pnpm admin:grant --email … --reason "…"` for den første hovedadmin. Kullisten lastes aldri opp til repoet eller bildet. Den kopieres inn i containeren bare for importen, og slettes etterpå.

Lokalt kan bildet bygges og prøves med `docker build -f apps/app/Dockerfile .`. Bildebehandlingen (sharp) har native binærfiler for plattformen den installeres på, og derfor bygges bildet på serveren.

## Før produksjon

Dette gjenstår før appen kan brukes av medlemmer:

1. **E-postleverandør.** Velg leverandør (f.eks. Resend, Postmark eller SES) og implementer `sendVerificationEmail` i `apps/app/src/server/auth.server.ts`. Legg nøkkelen i miljøet og i env-skjemaet. Legg samtidig til tilbakestilling av passord, som også trenger e-post. Sett opp SPF/DKIM for avsenderdomenet.
2. **Coolify.** Sett opp appen, Postgres, domenet og backup som beskrevet i «Appen med Coolify». Opprett en privat R2-bøtte for profilbilder (se «Profilbilder») og en for backup.
3. **Backup.** Test én gjenoppretting, og avklar lagringstid.
4. **Beskytt `main`.** Krev grønn «Sjekk og bygg» før merge, og ingen direkte push.
5. **Overvåking.** Oppetidssjekk mot `/api/health`, innsamling av feillogger og varsling til en navngitt person.
6. **Medlemsimport.** Importverktøyet finnes (se over). Det som gjenstår, er å avgjøre hvem som eier og verifiserer kullisten, rydde e-postadressene og kjøre importen mot produksjon.
7. **Personvern.** Behandlingsgrunnlag, personvernerklæring og rutine for sletting.

## Før repoet gjøres offentlig

Repoet er privat. CI er laget for å være trygt også som offentlig repo: PR-er fra forks kjører med lesetilgang og uten hemmeligheter, deploy-jobben hoppes over i forks, og ingen arbeidsflyt bruker `pull_request_target`. Dette må gjøres før repoet åpnes, i denne rekkefølgen:

1. **Fjern Gmail-adressen fra historikken.** Foreningens interne Gmail-adresse ligger i den første commiten (`9b9b9ff`), i `apps/site/KILDER.md` og `apps/site/src/site.config.ts`. Dagens filer har den ikke. Skriv om historikken, for eksempel med `git filter-repo --replace-text`, force-push alle grener og be alle med en klone om å klone på nytt. GitHub kan fortsatt vise gamle commits via SHA en stund. Be derfor GitHub Support rydde dem, eller opprett et nytt repo fra den ryddede historikken.
2. **Skann historikken på nytt**, for eksempel med gitleaks. En gjennomgang i oktober 2026 fant ingen nøkler eller ekte persondata utenom Gmail-adressen. Testdata bruker `example.test`-adresser og oppdiktede telefonnumre.
3. **Slå på secret scanning og push protection** under Settings → Code security.
4. **Beskytt `main`** med en ruleset som blokkerer force-push og sletting. Det er ikke tilgjengelig for private repoer på gratisplanen.
5. **Sjekk commit-forfattere.** E-postadressene i commitene blir synlige. Bruk GitHubs noreply-adresse framover hvis det ikke er ønsket.

## Åpne beslutninger

- **Tekst og kontakt på esaf.no:** Teksten bygger på ESAFs partnerpresentasjon fra 2025 og NTNUs studieside. Kontaktadressen er `styret@esaf.no`, som videresendes til foreningens Gmail. Styret må godkjenne formuleringene og bekrefte at aktivitetene fortsatt arrangeres. Se `apps/site/KILDER.md`. Logo og bilder fra Drive er ikke tatt i bruk før rettigheter og samtykke er avklart.
- **Hvem skal få medlemsinnsyn:** Alumni, nåværende studenter, ansatte og/eller mentorer? Datamodellen støtter alle fire via `person_cohort.relation`, men godkjenningen skiller ikke mellom dem ennå.
- **Telefonnumrene fra lista:** De er importert, men vises ikke før personen selv slår dem på. Lista ble delt for at ES-ere skulle kunne ringe hverandre, så styret kan velge å vise numrene for godkjente medlemmer fra start, med mulighet til å skjule dem. Det er én endring i `getProfile`.
- **Medlemsstatus for importerte profiler:** `active` (standard) eller `venter`, se sikkerhetsavveiingen over.
- **Hva medlemmer ser om hverandre:** Alle profilfelt er synlige for aktive medlemmer. E-post og telefon vises bare når personen selv slår det på.
- **Hosting for appen:** Ikke valgt. Repoet er `ESAF-NO/esaf` og er privat.
- **Innlogging:** Nå brukes e-post og passord med e-postbekreftelse. Magisk lenke, passkeys eller Google-innlogging kan legges til når e-post er på plass.
- **MCP:** Ikke implementert. Bygg på `@esaf/core` med den offisielle MCP TypeScript SDK. Better Auths MCP-plugin er i beta og bør testes i en egen integrasjonstest før den velges.

## Versjoner og begrensninger

Versjonene er låst i `pnpm-lock.yaml`. Viktige valg per 28. oktober 2026:

- **TypeScript 6.0**, ikke 7.0. typescript-eslint (`<6.1`) og `@astrojs/check` (`^5 || ^6`) støtter ennå ikke TypeScript 7.
- **Nitro 3** er fortsatt i beta, men det er det TanStack Starts egen mal bruker for Node-hosting. Versjonen er låst eksakt.
- **TanStack Start 1.169.** Serverfunksjoner bruker `.validator()`. Rutefilene genererer `src/routeTree.gen.ts`, som committes.
- **pnpm 12**, **Node 24**, **Postgres 18**, **Astro 7**, **Vite 8**, **Better Auth 1.7**, **Drizzle ORM 0.45**.

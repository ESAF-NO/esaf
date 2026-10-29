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

| Tabell                                       | Innhold                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`, `session`, `account`, `verification` | Better Auth: innloggingsidentitet. Gir ingen tilgang alene. `session.signed_in_with_passkey` sier om økten ble startet med passkey (se «Sterk innlogging»).                                                                                                                                                                                           |
| `two_factor`, `passkey`                      | Tofaktor (TOTP-hemmelighet og reservekoder) og passkeys (bare den offentlige nøkkelen, med navn, dato og om den synkroniseres).                                                                                                                                                                                                                       |
| `person`                                     | En person ESAF kjenner til. Uten `user_id` er det en _profil_ (f.eks. fra kullisten). Med `user_id` har personen selv tatt den i bruk (`claimed_at`). `source` sier om den kom fra registrering eller import.                                                                                                                                         |
| `experience`                                 | Hvor personen jobber og har jobbet: selskap (`company_id`), stilling, fra- og til-år og om personen grunnla selskapet. Uten til-år er det nåværende. Den nyeste nåværende vises som stilling under navnet.                                                                                                                                            |
| `company`                                    | Et selskap: unik `slug` (følger navnet), navn, kort beskrivelse, «om selskapet», nettside, grunnlagt, sted, bransjer og status (`active`/`acquired`/`closed`/`unknown`). `alias_slugs` er tidligere slugger og sammenslåtte duplikater. `last_seen_on_es_site` er sist selskapet sto på ES-siden (fra import). `person.es_company_id` peker også hit. |
| `company_event`                              | Historikken til et selskap: dato med presisjon (`year`/`month`/`day`), type (`founded`, `funding`, `award`, `launch`, `acquired`, `bankrupt`, `dissolved`, `closed`, `other`), tekst, kilde og `confidence` (`high`/`medium`/`low`).                                                                                                                  |
| `quote`                                      | Sitater: tekst, taleren (`person_id`, og alltid navnet slik kilden skriver det i `speaker_name`), rolle, selskap, dato, kilde og `confidence` for hvem som sa det.                                                                                                                                                                                    |
| `field_source`                               | Hvor et importert felt på en profil eller et selskap kom fra (`entity_type` + `entity_id`, felt, kilde, lenke, hentet, `confidence`), når eieren bekreftet det (`confirmed_at`) og når en admin så over det under Gjennomgang (`reviewed_at`). Uten fremmednøkkel; `@esaf/core` flytter og sletter radene ved sammenslåing og opprydding.             |
| `company_suggestion`                         | Forslag fra medlemmer til et selskap: `kind` `info` (bare feltene som endres, med verdien før og etter, i `changes`) eller `event` (en ny hendelse), valgfri kommentar, og status (`pending`/`accepted`/`rejected`/`withdrawn`) med hvem som behandlet det.                                                                                           |
| `company_link_request`                       | «Denne personen var med i selskapet»: personen, rollen (`founder`/`es`/`employee`), stilling og år, hvem som sa det, og status. Bare én åpen per person, selskap og rolle. Blir erfaring eller ES-selskap når personen bekrefter.                                                                                                                     |
| `review_dismissal`                           | Mulige duplikater (selskaper eller personer) en admin har sagt at ikke er det samme, så de ikke foreslås igjen.                                                                                                                                                                                                                                       |
| `cohort`                                     | Et kull, identifisert ved uteksamineringsåret, slik ES selv navngir kull: «ES 2024» startet høsten 2022.                                                                                                                                                                                                                                              |
| `person_cohort`                              | Tilknytning mellom person og kull, med type: `student`, `staff` eller `mentor`.                                                                                                                                                                                                                                                                       |
| `person_email`                               | Alle kjente e-postadresser for en person (registrering, kulliste, NTNU-mail, senere andre kilder). Brukes til å koble en konto til riktig profil. Vises aldri for andre medlemmer.                                                                                                                                                                    |
| `membership`                                 | ESAFs avgjørelse om personen: `status` (`pending`/`active`/`inactive`) og `role` (`member`/`moderator`/`admin`/`owner`).                                                                                                                                                                                                                              |
| `access_request`                             | Forespørsel om tilgang fra en konto med bekreftet e-post: navn, kull, valgfri LinkedIn og melding, og eventuelt profilen fra kullisten personen sier er dem. Status `open`, `approved` eller `rejected`.                                                                                                                                              |
| `audit_event`                                | Revisjonslogg: forespørsler, godkjenninger, roller, deaktiveringer, importer, adminredigering og moderering. Skrives aldri over.                                                                                                                                                                                                                      |
| `post`, `comment`, `post_vote`               | Feeden. Tekst i Markdown. `edited_at` settes når forfatteren endrer innholdet, `pinned_at` når en moderator fester et innlegg, og `deleted_at` skjuler innhold uten å slette det.                                                                                                                                                                     |
| `notification`                               | Varsler til ett medlem: type, hvem som utløste det, innlegget, kommentaren eller selskapet det gjelder, `read_at` og `emailed_at`. Unik `event_key` per mottaker hindrer doble varsler.                                                                                                                                                               |

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
- **Festede innlegg:** Moderatorer og oppover (admins sterkt innlogget) kan feste og løsne innlegg. Festede innlegg står øverst i «Hjem» og i kanalen sin, sist festet først, merket «Festet». I søk, på profiler og på kullsider vises innleggene i vanlig rekkefølge. Festing og løsning logges (`content.pin_post`, `content.unpin_post`).
- **Varsler og omtaler**, se under.
- **Personer** (`/medlemmer`) er en katalog med søk, kullfilter, filter for verifiserte og de mest brukte emnene og bransjene som snarveier. Søket treffer også tidligere selskaper og stillinger.
- **Kull** (`/kull`) viser alle kull med antall personer og hvor mange som har tatt i bruk profilen. Ditt eget kull er merket, og står også i sidekolonnen på forsiden. Hvert kull har en egen side (`/kull/2024` for ES 2024, som gikk 2022–2024) med personene, selskapene folk i kullet har grunnlagt eller hadde på ES, og de nyeste innleggene deres. Mentorer og ansatte vises for seg. Kullet på profiler og «Ditt kull» på forsiden lenker hit, og «Søk i kullet» går til katalogen filtrert på kullet. Ukjente årstall gir 404.
- **Selskaper** (`/selskaper`) viser selskaper startet av alumni, både ES-selskaper (fra «Selskap på Entreprenørskolen») og selskaper noen har grunnlagt (fra erfaring). «Alle selskaper» viser også arbeidsgivere. Oversikten kan søkes og filtreres på bransje (`?q=…&bransje=…`). Hvert selskap har en egen side (`/selskaper/:slug`), se «Selskaper» under.
- **Søk** med ⌘K (eller `/`) finner personer, selskaper og innlegg fra hvor som helst i appen.
- **Forsiden** viser en velkomst med snarveier til profilen, kullet og første innlegg så lenge feeden er tom. I sidekolonnen står et tilfeldig sitat fra en ES-er (se «Sitater»).
- **Admin** (`/admin`) med fanene Forespørsler, Gjennomgang, Medlemmer, Profiler, Selskaper og Logg, se «Roller og rettigheter» og «Adminverktøy for data».
- **Konto og sikkerhet** (`/konto`): passkeys (legge til, gi nytt navn, fjerne), tofaktor med autentiseringsapp, bytte passord og logge ut andre enheter. Innlogging (`/logg-inn`) med e-post og passord, eller med passkey: knappen «Logg inn med passkey», eller nettleserens forslag i e-postfeltet.
- **Profiler og redigering**, se under.

Ikke bygget ennå: direktemeldinger, varsler på e-post, medlemsfordeler og jobber som egen modul. Jobber er foreløpig en kanal i feeden.

### Varsler og omtaler

Klokka i toppen viser antall uleste varsler og de siste varslene. Et klikk åpner innlegget eller kommentaren og merker varselet som lest. `/varsler` viser alle, delt i i dag og tidligere, med «Merk alle som lest».

- **Hvem får varsel:** forfatteren når noen kommenterer innlegget, alle som har kommentert et innlegg når noen kommenterer det igjen, den som blir nevnt med @ i et innlegg eller en kommentar, den som blir godkjent (velkomst), og de fra samme kull når noen fra kullet blir godkjent. For selskaper: gründerne, ES-teamet og de som jobber der nå når noen foreslår en endring, den som foreslo når forslaget er godtatt eller avslått, den som er nevnt når noen sier at de var med i et selskap, og den som sa det når personen bekrefter. Selskapsvarsler leder til selskapssiden.
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
- **Sitater** fra personen vises på profilen (se «Selskaper»).
- **Kilder:** Felt som er importert (f.eks. bio fra entreprenorskolen.no eller studieretning fra kullisten) og som ingen har bekreftet, får et diskret merke under feltet: «Fra entreprenorskolen.no · ikke bekreftet». Eieren ser en stripe øverst med «Stemmer, bekreft alt» og en «Stemmer»-knapp per felt. Skriver eieren om et felt, regnes det også som bekreftet (`confirmed_at`); felt eieren ikke rører, forblir ubekreftet. Retter en admin feltet, gjelder ikke kilden lenger, og den slettes (endringen står i loggen). Medlemmer ser kilden og om den er bekreftet; bare admins ser hvor sikker den er. E-post og telefon har aldri kilder i appen, så kildene kan ikke røpe skjult kontaktinfo. Reglene ligger i `packages/core/src/sources.ts`.

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

Selskapssiden (`/selskaper/:slug`) viser navn, kort beskrivelse, status (aktiv, oppkjøpt, nedlagt, ukjent status), nettside, grunnlagt, sted, bransjer og «om selskapet». Under «Fra ES» står gründerne, ES-teamet (med kull), de som jobber der nå og de som har jobbet der, med stilling og år, og lenker til profilene. Bare aktive medlemmer vises.

- **Redigering:** Gründere (også tidligere), ES-teamet og de som jobber der nå kan redigere selskapsinfoen, og admins med `profiles.edit`. Tidligere ansatte og andre medlemmer kan ikke, men kan foreslå endringer (se under). Admins som ikke selv er knyttet til selskapet, logges som `company.admin_edit`. Validering ligger i `companyInput` i `@esaf/core`; nettsider må være http eller https.
- **«Jeg var med her»:** Alle aktive medlemmer kan legge seg selv til i et selskap som gründer, ES-team eller ansatt (stilling og år, nå eller før). Det gjelder dem selv, så det lagres med en gang som erfaring eller ES-selskap, som på profilen, og importerte kilder for feltet regnes som bekreftet. Som gründer, ES-team eller ansatt nå kan de da redigere selskapet. «Fjern meg herfra» fjerner all erfaring der og ES-selskapet; et selskap som bare fantes fra et navn og som ingen lenger er knyttet til, ryddes bort. Har man allerede et annet ES-selskap, må det endres på profilen.
- **Forslag:** Medlemmer som ikke kan redigere, får «Foreslå endring» (`/selskaper/:slug/foresla`, samme skjema som redigeringen, bare feltene som endres lagres) og «Foreslå hendelse» i historikken, med valgfri kommentar. De som kan redigere, ser åpne forslag øverst på selskapssiden med verdien nå og den foreslåtte, og godtar eller avslår; admins ser dem også under Gjennomgang. Et godtatt forslag lagres som om den som godtok, hadde gjort endringen selv (navnebytte gir alias, kildene bekreftes eller glemmes). Den som foreslo, ser egne forslag på siden og kan trekke dem, og ingen behandler sine egne. Admins uten tilknytning logges (`company.admin_suggestion_accept`, `company.admin_suggestion_reject`). Grenser: høyst 3 åpne forslag per selskap, 10 åpne totalt og 20 nye i døgnet per medlem.
- **Andre personer:** «Legg til en person» lar et medlem si at en annen var med (gründer, ES-team eller ansatt). Det blir en forespørsel personen må bekrefte («Stemmer» / «Stemmer ikke») med varsel, på selskapssiden og øverst på egen profil, og den vises ikke for andre før den er bekreftet. Den som spurte, ser forespørselen som «venter på bekreftelse» og kan trekke den. For profiler ingen har tatt i bruk, kan admins bekrefte under Gjennomgang; admins kan avslå alle. Begge logges (`company.admin_link_accept`, `company.admin_link_reject`). Grenser: høyst 20 åpne og 20 nye i døgnet per medlem.
- Reglene for bidrag ligger i `packages/core/src/contributions.ts`.
- **Logo:** Lastes opp, byttes og fjernes øverst på redigeringssiden, av de samme som kan redigere selskapsinfoen. Admins som ikke er knyttet til selskapet, logges som `company.admin_logo_upload` og `company.admin_logo_remove`. Samme filtyper og grenser som profilbilder (se «Profilbilder»), men logoen beskjæres aldri: den skaleres inn i et kvadrat, gjennomsiktighet beholdes, og den lagres som WebP i 256 og 64 piksler under `logoer/` (`company.logo_key`, ny nøkkel per opplasting, gamle filer slettes). SVG avvises. `GET /api/logoer/<nøkkel>-<størrelse>.webp` har samme tilgang og caching som bildene; opplasting er `PUT` og `DELETE` på `/api/selskaper/<companyId>/logo`. Uten logo vises en bokstavflis. Reglene ligger i `packages/core/src/logos.ts`.
- **Nytt navn** gir ny slug. Den gamle blir et alias, så gamle lenker sendes videre og den gamle skrivemåten kobles fortsatt til selskapet. Et navn som tilhører et annet selskap, avvises.
- **Erfaring:** Selskapsfeltet i profilen og velkomststegene foreslår selskaper som finnes mens man skriver. Et valgt forslag kobles på id. Skriver man et navn, kobles det til selskapet med samme slug («kahoot» blir «Kahoot!»), ellers blir det et nytt selskap. Et selskap som bare ble laget fra et navn og som ingen lenger er knyttet til (for eksempel en rettet skrivefeil), ryddes bort. Importen fra kullisten kobler selskaper på samme måte.
- **Duplikater:** «Statkraft AS» og «Statkraft» er to slugger. Forslagene viser «Statkraft» når man skriver «Statkraft AS», og en admin kan slå dem sammen nederst på redigeringssiden eller fra Gjennomgang. Erfaring, ES-team, historikk, sitater, forslag, forespørsler og varsler flyttes, tomme felt fylles fra duplikatet, og duplikatets slug blir et alias. Har bare duplikatet logo, flyttes den; har begge, beholdes logoen til selskapet det slås sammen med. Logges som `company.merge`.
- **Søk:** ⌘K finner selskaper uansett skrivemåte og går til selskapssiden.
- **Ukjent status:** Standard i databasen og for selskaper fra import (kullisten, berikelse), der ingen har sagt om selskapet lever. Skriver et medlem inn et nytt selskap under erfaring, blir det `active` som før: de vet at det finnes (`resolveCompanies(…, { status })`). Eksisterende selskaper beholdt statusen sin i migrering `0015`. Har selskapet ukjent status, viser siden «Sist nevnt på ES-siden 2016» fra `last_seen_on_es_site`. Oversikten kan filtreres på status (`?status=unknown`).
- **Historikk:** Hendelser (grunnlagt, kapital, priser, lanseringer, oppkjøp, konkurs, oppløst, lagt ned), nyeste først, med kildelenke i ny fane. De samme som kan redigere selskapsinfoen, kan legge til, rette og slette dem; admins som ikke er knyttet til selskapet, logges som `company.admin_event_add`, `company.admin_event_edit` og `company.admin_event_remove`. Hendelser med lav sikkerhet fra import (setninger hentet automatisk fra nyhetssaker) vises bare for dem som kan redigere, under «Til gjennomgang»; «Stemmer» eller en redigering gjør dem synlige for alle. Reglene ligger i `packages/core/src/company-events.ts`.
- **Sitater** om selskapet eller fra folk i det vises på selskapssiden, sitater fra en person på profilen, og et tilfeldig sitat på forsiden (helst sikkert, fra et medlem og kort). Bare aktive medlemmer vises som talere. Sitater der det er usikkert hvem som sa det (`confidence = low`), skjules for medlemmer; admins ser dem merket «Usikker taler». Admins retter og sletter sitater (`quote.edit`, `quote.remove`), og den som er sitert, kan fjerne sine egne. Reglene ligger i `packages/core/src/quotes.ts`.
- **Kilder:** «Kilder» nederst i sidekolonnen viser hvor hvert importert felt kom fra, når det ble hentet og om det er bekreftet. De som er knyttet til selskapet, bekrefter feltene de endrer; endrer en admin uten tilknytning dem, slettes kilden. Bare admins ser hvor sikker kilden er. Kildelenker som ikke er http eller https, sendes aldri til nettleseren.

## Adminverktøy for data

Krever `profiles.edit` (admins, sterkt innlogget). Alt som endrer noe, logges. Forslag, forespørsler, avviste duplikater og `field_source.reviewed_at` kom i migrering `0017`.

- **Gjennomgang** (`/admin/gjennomgang`): alt som er usikkert, samlet ett sted, med antallet i fanen. Delene er forslag fra medlemmer, tilknytninger til profiler uten konto, hendelser og sitater med lav sikkerhet fra import, importerte felt ingen har bekreftet eller sett over (samlet per person og selskap), og mulige duplikater. Hver sak har godkjenn, rediger (lenke eller dialog) og forkast, med ett klikk der det er trygt, og sider på 20.
  - Hendelser: «Stemmer» gjør dem synlige (`company.admin_event_confirm`). Sitater: «Riktig taler» (`quote.confirm`).
  - Importerte felt: «Ser riktig ut» per felt eller for hele personen eller selskapet setter `reviewed_at` (`source.review`). Det er ikke en bekreftelse fra eieren, så profilen viser fortsatt «ikke bekreftet» til personen selv bekrefter. «Fjern» tømmer et felt som er feil, og kildene for det (`profile.admin_clear_field`, `company.admin_clear_field`); bilde, logo, navn og erfaring rettes på redigeringssiden. Kontaktinfo er aldri med.
  - Like selskaper: samme navn uten selskapsform («Statkraft AS» og «Statkraft»), nesten lik slug (én bokstav, for navn på minst seks tegn) eller samme nettside (ikke delte nettsteder som LinkedIn). Organisasjonsnummer lagres ikke ennå, så det brukes ikke.
  - Like personer: samme navn (uten aksenter og store bokstaver) og kull innenfor ett år eller uten kull, samme fornavn og etternavn med ulike mellomnavn, samme e-post (også Gmail-varianter og kontaktadressen) eller samme LinkedIn.
  - Duplikater slås sammen med ett klikk og en bekreftelse, eller avvises med «Ikke samme» (`review.dismiss_duplicate`), og foreslås da ikke igjen. Reglene ligger i `packages/core/src/review.ts`.
- **Selskaper** (`/admin/selskaper`): alle selskaper, også dem ingen er knyttet til, med søk, filter (status med ukjent, uten logo, beskrivelse, personer eller historikk, ES-selskap, kull), sortering og snarveier til redigering og sammenslåing. «Nytt selskap» oppretter for hånd (`company.create`); navn som finnes, også som tidligere navn, avvises. Sletting (`company.delete`) av et selskap noen er knyttet til, krever at admin krysser av for at koblingene fjernes fra profilene og skriver en begrunnelse; historikk, kilder, forslag og logo slettes, og sitater beholdes uten selskap. Reglene ligger i `packages/core/src/company-admin.ts`.
- **Profiler** (`/admin/profiler`): alle personer, med og uten konto, også ventende og deaktiverte, med søk og filter. «Ny profil» lager en profil som fra kullisten, med navn, kull og kjente e-postadresser, og viser personer med samme navn og nære kull før den lages (`profile.create`, `person.source = admin`). Det gir aldri tilgang til noen konto.
- **Redigering av en person** (`/medlemmer/:id/rediger`): admins ser i tillegg «Bare for admins» med kull og tilknytning (student, ansatt, mentor; `profile.admin_cohorts`), kjente e-postadresser (`person_email`; `profile.admin_email_add`, `profile.admin_email_remove`; adressen kontoen logger inn med kan ikke fjernes, og adressene vises aldri for andre medlemmer) og «Slå sammen duplikat». Erfaring og ES-selskap rettes i skjemaet over, som før.
- **Sammenslåing av personer** (`person.merge`) flytter erfaring (like rader én gang), kull, e-post, sitater, kilder for feltene som hentes, innlegg, kommentarer, stemmer, varsler, forslag, forespørsler og pekere i forespørsler om tilgang, og fyller tomme felt fra duplikatet. Har én av dem konto, er det den som beholdes, og kontaktinfoen dens røres ikke. To kontoer slås aldri sammen. Revisjonsloggen peker etterpå på personen som ble beholdt, og hendelsen `person.merge` sier hvem som ble slått sammen. Reglene ligger i `packages/core/src/people-admin.ts`.

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
- **Selskaper** fra lista som ikke finnes fra før, får ukjent status.
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

| Rettighet          | Hva den gir                                                        | Moderator | Admin | Hovedadmin |
| ------------------ | ------------------------------------------------------------------ | :-------: | :---: | :--------: |
| `content.moderate` | Fjerne andres innlegg og kommentarer                               |     ✓     |   ✓   |     ✓      |
| `members.review`   | Behandle forespørsler om tilgang og koble kontoer til profiler     |           |   ✓   |     ✓      |
| `members.manage`   | Deaktivere og gjenopprette medlemmer (se under om admins)          |           |   ✓   |     ✓      |
| `profiles.edit`    | Rette andres profiler (aldri kontaktinfo), selskaper, Gjennomgang  |           |   ✓   |     ✓      |
| `audit.read`       | Lese revisjonsloggen                                               |           |   ✓   |     ✓      |
| `roles.manage`     | Gi og fjerne roller, og endre tilgangen til admins og hovedadmins  |           |       |     ✓      |
| Sterk innlogging   | Passkey-økt eller tofaktor; ellers sender adminsidene til `/konto` |           |   ✓   |     ✓      |

Vanlige medlemmer (`member`) har ingen av rettighetene. `owner` heter «hovedadmin» i appen.

- **Sterk innlogging:** Admins og hovedadmins kan bare bruke rettighetene sine i en sterk økt, se under. Ellers sender `/admin` til `/konto?krav=sterk-innlogging`, og serveren svarer `strong_auth_required`. Moderatorer har ikke noe slikt krav.
- **Medlemmer som har mistet passkeyene sine:** Under Admin → Medlemmer kan passkeyene til en person fjernes, med begrunnelse. Samme regler som for deaktivering: admins for medlemmer og moderatorer, hovedadmins også for admins, aldri en selv. Personen logges ut overalt og kan legge til nye etter å ha logget inn med passord. Logges som `security.remove_passkeys`.
- **Roller gis i appen** av en hovedadmin under Admin → Medlemmer, med valgfri begrunnelse. Ingen kan endre sin egen rolle, og det finnes alltid minst én aktiv hovedadmin. Registrering og godkjenning gir aldri rolle; godkjenning setter bare `status`. Better Auths admin-plugin er ikke i bruk, og `user`-tabellen har ikke noe rollefelt.
- **Deaktivering** (Admin → Medlemmer) krever begrunnelse. Personen logges ut på alle enheter med en gang (øktene slettes), mister tilgangen og vises ikke lenger i katalogen. Rollen settes tilbake til medlem, så rettigheter må gis på nytt om tilgangen gjenopprettes. Admins kan deaktivere og gjenopprette medlemmer og moderatorer; bare en hovedadmin kan endre tilgangen til admins og hovedadmins. Ingen kan deaktivere seg selv.
- **Revisjonsloggen** (Admin → Logg) viser hvem som gjorde hva, nyeste først, med begrunnelsen når den finnes. Den dekker forespørsler og godkjenninger (`access.*`, `membership.*`), roller (`role.change`, `operator.grant_role`), import (`operator.import_profiles`), adminredigering, oppretting, sammenslåing og kobling av profiler (`profile.*`, `person.merge`), adminendringer på selskaper (`company.*`), sitater (`quote.*`), Gjennomgang (`source.review`, `review.dismiss_duplicate`) og moderering (`content.remove_post`, `content.remove_comment`). Hendelser uten utfører kommer fra en operatør på kommandolinjen. Loggen kan ikke endres i appen.

Testene ligger i `packages/core/test/`. Rene enhetstester dekker alle kombinasjoner av status og rolle. `contributions.integration.test.ts` dekker «Jeg var med her» og fjerning, forslag (godta, avslå, trekke, grenser, varsler), forespørsler om andre (bekrefte, avslå, admin for profiler uten konto) og at sammenslåing av selskaper tar dem med. `review.integration.test.ts` dekker at bare sterkt innloggede admins når verktøyene, køen og handlingene i den, duplikatsøket, opprettelse og sletting av selskaper, kull og e-post, sammenslåing av personer og at alt logges. Integrasjonstester mot Postgres dekker uinnlogget og ubekreftet bruker, ventende bruker, medlem uten rettigheter, selvgodkjenning, at en bekreftet adresse fra kullisten ikke gir tilgang alene, at søkere ikke kan velge andres profil, godkjenning med og uten profil, avslag, operatørens rolletildeling, rolleendringer, kravet om sterk innlogging, fjerning av passkeys, deaktivering og revisjonsloggen.

`apps/app/test/passkey.integration.test.ts` kjører Better Auth-oppsettet (`createAuth` i `auth-config.server.ts`) mot testdatabasen med en programvare-autentikator i stedet for nettleseren. Den dekker at passkey-økter merkes og gir sterk innlogging, at passord alene ikke gjør det, at økten ikke kan merkes fra klienten, at passkeyen må bekrefte personen (biometri eller PIN), at svar for en annen opprinnelse avvises, at ubekreftede og deaktiverte kontoer ikke kommer inn, at en passkey-innlogging erstatter passordøkten, registrering, og at en passordøkt ikke kan bytte ut passkeys. Turbo kjører appens tester etter `@esaf/core`, fordi de deler testdatabasen.

### Sterk innlogging

Regelen står i `strongAuth` i `packages/core/src/access.ts`, og `loadViewer` får økten fra Better Auth (`getRequestViewer` i `apps/app/src/server/viewer.server.ts`). En økt er sterk når:

- **den ble startet med passkey.** Feltet `session.signed_in_with_passkey` settes av en databasehook i `auth-config.server.ts`, bare når økten lages av `/passkey/verify-authentication`. Klienten kan ikke sette det, og det endres aldri etterpå. Passkeyen må ha bekreftet personen med ansikt, fingeravtrykk eller PIN, ellers avvises innloggingen. Den er dermed to faktorer i ett.
- **eller kontoen har tofaktor.** Da krever innlogging med passord alltid koden, så alle øktene regnes som sterke.

En konto med bare passkey som logger inn med passord, får en vanlig økt. Adminverktøyene sender da til `/konto`, som viser «Logg inn med passkey for å bruke adminverktøyene» og en knapp. Innlogging med passkey fra en innlogget økt gir en ny, sterk økt, og den gamle slettes. Uten verken passkey eller tofaktor viser `/konto` begge valgene.

Har kontoen passkey, må økten være sterk for å legge til eller fjerne passkeys og for å slå på tofaktor (`mayChangeSignInMethods`, håndhevet i en Better Auth-hook). Ellers kunne den som bare kan passordet, bytte ut passkeyen med sin egen. Den første passkeyen kan legges til fra en vanlig økt, slik tofaktor alltid har kunnet slås på med passordet. Å legge til en passkey krever i tillegg en fersk økt (Better Auths `freshAge`, ett døgn), som pluginen anbefaler.

Passkeys er bundet til vertsnavnet i `BETTER_AUTH_URL` (WebAuthn `rpID`), og bare svar fra den opprinnelsen godtas: `localhost` på `http://localhost:3000` i utvikling, `app.esaf.no` i produksjon. Flyttes appen til et annet domene, virker ikke passkeyene lenger, og medlemmene må logge inn med passord og legge til nye. Innlogging med passkey avslører aldri om en konto finnes: den starter uten e-post, og en ukjent passkey får samme melding som en som ikke virket. Den har samme rate-grense som innlogging med passord (tre forsøk per ti sekunder), og deaktiverte medlemmer får samme svar som med passord: ingen tilgang.

### Første hovedadmin

Det finnes ingen standardbruker og ingen automatisk admin basert på e-postdomene. Den første hovedadmin gis av en operatør med direkte databasetilgang. Etter det gir hovedadmins roller i appen.

1. Personen registrerer seg i appen, bekrefter e-postadressen og svarer på «Hvem er du?».
2. Operatøren kjører, med `DATABASE_URL` mot riktig database. Det godkjenner forespørselen (og kobler kontoen til profilen personen valgte fra kullisten) og gir rollen hovedadmin:
   ```sh
   pnpm admin:grant --email navn@example.com --reason "Styreleder 2026"
   pnpm admin:grant --email navn@example.com --reason "…" --rolle admin   # eller moderator
   ```
3. Skriptet viser hvilken database det kobler til og krever at e-postadressen skrives inn på nytt. Det nekter å kjøre uten interaktiv terminal, og nekter kontoer med ubekreftet e-post. Tildelingen havner i revisjonsloggen med begrunnelsen.
4. Personen legger til en passkey under «Konto og sikkerhet» og logger inn med den, eller slår på tofaktor. Før det virker ikke adminrettighetene.

### Lokal innlogging

Lokalt sendes ingen e-post. Bekreftelseslenken skrives ut i terminalen der `pnpm dev` kjører («Bekreftelseslenke for …»). Åpne den for å bekrefte kontoen. Da logges du inn og havner på «Hvem er du?». I produksjon kaster samme kode en feil til en e-postleverandør er satt opp (se under). Da kan ingen kontoer bekreftes, og det finnes ingen vei utenom.

## Sikkerhet i koden

- **Server-only kode:** `apps/app/vite.config.ts` slår på TanStack Starts import protection med `behavior: 'error'`. Klientbundelen kan ikke importere `@esaf/db`, `@esaf/core`, `pg`, `drizzle-orm`, filer i `src/server/` eller `*.server.*`. ESLint har samme regel for rutefilene.
- **Miljøvariabler** valideres med zod i `apps/app/src/server/env.server.ts`. En Nitro-plugin kjører valideringen ved oppstart, så produksjonsserveren stopper med en tydelig feilmelding hvis noe mangler. Produksjon avviser eksempelhemmeligheten fra `.env.example` og `http`-URL-er som ikke peker til localhost.
- **Statisk side:** `pnpm verify:site` (kjøres også i CI) leter i `apps/site/dist` etter database-URL-er, navn på servervariabler, kode fra appen, nøkler og faktiske verdier fra `.env`. Den feiler også på e-postadresser som ikke er satt som `contactEmail` i `apps/site/src/site.config.ts`.
- **Hemmeligheter:** `.env` er gitignorert. `.env.example` inneholder bare ufarlige lokale verdier.

## Deploy

Nettsiden ligger på https://esaf.no og deployes automatisk til Cloudflare fra GitHub Actions. Appen er ikke deployet. `esaf.no` ligger i ESAFs Cloudflare-konto, der Email Routing også er slått på for å videresende `styret@esaf.no` til foreningens Gmail.

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

### Appen på Node

`pnpm --filter @esaf/app build` gir en selvstendig Node-server i `apps/app/.output/` (Nitro). Den kjøres slik:

```sh
pnpm db:migrate                      # med produksjonens DATABASE_URL, før oppstart
NODE_ENV=production PORT=3000 \
DATABASE_URL=postgres://… BETTER_AUTH_SECRET=… BETTER_AUTH_URL=https://app.esaf.no \
S3_ENDPOINT=https://<konto-id>.r2.cloudflarestorage.com S3_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
node apps/app/.output/server/index.mjs
```

Bildebehandlingen (sharp) har native binærfiler for plattformen den installeres på. Bygg derfor `.output/` på samme operativsystem og arkitektur som serveren (f.eks. i CI eller i Docker-bildet), ikke på en Mac for en Linux-server.

Bare `.output/` trengs på serveren. Den kan kopieres til en VPS eller pakkes i et container-image (`node:24-slim`, `COPY .output`, `CMD node .output/server/index.mjs`). Det finnes ingen Dockerfile ennå. Den bør lages og testes når vertsplattformen er valgt. Helsesjekk: `GET /api/health` gir 200 når databasen svarer og 503 ellers.

## Før produksjon

Dette gjenstår før appen kan brukes av medlemmer:

1. **E-postleverandør.** Velg leverandør (f.eks. Resend, Postmark eller SES) og implementer `sendVerificationEmail` i `apps/app/src/server/auth.server.ts`. Legg nøkkelen i miljøet og i env-skjemaet. Legg samtidig til tilbakestilling av passord, som også trenger e-post. Sett opp SPF/DKIM for avsenderdomenet.
2. **Hosting og database.** Velg vert for appen og en administrert eller selvdriftet Postgres. Velg dem samlet, ut fra driftsansvar og kostnad. Opprett en privat R2-bøtte for profilbilder (se «Profilbilder»).
3. **Backup.** Automatisk, kryptert backup av Postgres med testet gjenoppretting og avklart lagringstid.
4. **Deploy.** Deploy-jobb for appen, med migrering som eget steg. Bestem `app.esaf.no` og DNS i Cloudflare.
5. **Rate-grenser.** Better Auth holder tellerne i minnet, per prosess. Kjører appen i flere prosesser, må de flyttes til en delt lagring (`rateLimit.storage`).
6. **Overvåking.** Oppetidssjekk mot `/api/health`, innsamling av feillogger og varsling til en navngitt person.
7. **Medlemsimport.** Importverktøyet finnes (se over). Det som gjenstår, er å avgjøre hvem som eier og verifiserer kullisten, rydde e-postadressene og kjøre importen mot produksjon.
8. **Personvern.** Behandlingsgrunnlag, personvernerklæring og rutine for sletting.

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
- **Innlogging:** E-post og passord med e-postbekreftelse, passkeys og tofaktor. Magisk lenke eller Google-innlogging kan legges til når e-post er på plass.
- **MCP:** Ikke implementert. Bygg på `@esaf/core` med den offisielle MCP TypeScript SDK. Better Auths MCP-plugin er i beta og bør testes i en egen integrasjonstest før den velges.

## Versjoner og begrensninger

Versjonene er låst i `pnpm-lock.yaml`. Viktige valg per 28. oktober 2026:

- **TypeScript 6.0**, ikke 7.0. typescript-eslint (`<6.1`) og `@astrojs/check` (`^5 || ^6`) støtter ennå ikke TypeScript 7.
- **Nitro 3** er fortsatt i beta, men det er det TanStack Starts egen mal bruker for Node-hosting. Versjonen er låst eksakt.
- **TanStack Start 1.169.** Serverfunksjoner bruker `.validator()`. Rutefilene genererer `src/routeTree.gen.ts`, som committes.
- **pnpm 12**, **Node 24**, **Postgres 18**, **Astro 7**, **Vite 8**, **Better Auth 1.7** (med `@better-auth/passkey` i samme versjon), **Drizzle ORM 0.45**.

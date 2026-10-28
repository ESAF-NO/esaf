# Kilder for tekst på esaf.no

Redaksjonelle notater for innholdet på nettsiden (`src/pages/`, `src/board.ts` og `src/sponsors.ts`). Teksten er skrevet for nettsiden, ikke kopiert fra kildene. Lenker til interne Drive-dokumenter skal **ikke** legges her, fordi repoet kan bli offentlig. Bruk dokumenttittel og plassering i stedet.

| Påstand på siden                                                                        | Kilde                                                                                                                                                                                                                     | Status                                                          |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| ESAF er et tverrfaglig nettverk av studenter og alumni ved NTNUs Entreprenørskole       | ESAFs partnerpresentasjon 2025 (Drive); NTNU, studiemiljøsiden for programmet                                                                                                                                             | Må godkjennes av styret                                         |
| Toårig masterprogram i Trondheim, fag i strategi, økonomi og forretningsutvikling, team | https://www.ntnu.no/studier/entreprenoerskap                                                                                                                                                                              | Offentlig kilde                                                 |
| Om lag halvparten fortsetter med selskapet de startet                                   | NTNUs studieside for Entreprenørskolen                                                                                                                                                                                    | Offentlig kilde, sjekk at teksten fortsatt står                 |
| ESAF-helg i Trondheim med workshops og veiledning av nåværende studentteam              | ESAFs partnerpresentasjon 2025 (Drive)                                                                                                                                                                                    | Styret bekrefter at det fortsatt arrangeres                     |
| ESAF-talks og sosiale arrangementer                                                     | ESAFs partnerpresentasjon 2025 (Drive)                                                                                                                                                                                    | Styret bekrefter at det fortsatt arrangeres                     |
| ESAF drives av alumni og ser etter sponsorer og samarbeidspartnere til arrangementer    | Styret (muntlig, 2026)                                                                                                                                                                                                    | Styret bekrefter ordlyden                                       |
| Bedrifter kan bli partner for hele året eller for enkeltarrangementer som ESAF-helg     | ESAF partnerpakker 2026 (Drive, mappen 2026/Spons)                                                                                                                                                                        | Styret bekrefter ordlyden                                       |
| Navnene på styret 2026, uten roller                                                     | Generalforsamlingsprotokoll 28. november 2025 (Drive); offentlig innlegg om ESAF-helg 2026: https://no.linkedin.com/posts/jorgen-berntson-aase_for-to-uker-siden-arrangerte-vi-i-styret-activity-7442503063334096896-fC2p | Oppdateres etter neste generalforsamling                        |
| Kontakt: styret@esaf.no                                                                 | Cloudflare Email Routing (esaf.no) videresender til styret. Den interne Gmail-adressen publiseres ikke                                                                                                                    | Adressen må settes opp i Cloudflare Email Routing før lansering |

Bevisst utelatt: omtale av ESAF-appen (tas inn igjen ved lansering), medlemstall («over 500 medlemmer» er et udatert 2025-tall), priser, styreroller (styret fordeler dem internt), sponsornavn, private kontaktopplysninger, datoer for kommende arrangementer og hvor ofte arrangementene holdes.

## Styret

Navnene på forsiden kommer fra `src/board.ts`. Oppdater året og navnene etter hver generalforsamling. Ikke legg inn roller eller portretter før styret har bekreftet dem.

## Sponsorer

Navn på `/sponsorer` kommer fra `src/sponsors.ts`. Det interne sponsorarket for 2026 (`Spons 2026`) er en arbeidsliste, ikke en godkjent liste: det blander ulike typer bidrag og arrangementer, og ikke alle avtaler gir rett til å bli vist på nettsiden. Før en sponsor legges inn, må styret bekrefte navn, avtaletype, periode, lenke og beskrivelse, og at sponsoren har sagt ja til å bli nevnt.

Helårspartnerpakken for 2026 lover logo og bedriftsbeskrivelse på nettsiden. Siden viser ikke logoer ennå. Logovisning bygges når den første logoen er godkjent.

## Bilder

Ingen bilder fra Drive er tatt i bruk ennå. Før et bilde legges i `public/`: bekreft at det er gjeldende (logo) eller at ESAF kan publisere det (fotograf, samtykke fra identifiserbare personer), fjern metadata, optimaliser størrelsen og skriv alt-tekst. Noter kildefil og avklaring her. Bruk aldri en Drive-URL som bildehost.

Gjennomgått, men ikke godkjent (filene ligger ikke i repoet):

- Eldre ESAF-logo (grønn og svart, 2013) og ESAF-helg-logoen fra 2013. Styret må bekrefte hvilken logo som gjelder i dag. ESAF-helg-logoen fra 2013 skal ikke brukes som dagens eventlogo.
- Tre bilder fra ESAF-helg 2024 (Drive). De viser fest, ikke workshops. Fotograf og samtykke fra de avbildede må avklares.
- To små bilder fra den gamle ESAF-forsiden. Historiske, ikke aktuelle for den nye siden.
- Alumniportretter på https://www.entreprenorskolen.no/alumni. Entreprenørskolen må gi originalfiler og avklare gjenbruk.
- Det finnes ingen godkjente styreportretter eller gruppebilde av styret. Spør styret og fotografen fra ESAF-helg 2026.

# Produksjonsbilde for appen. Byggekonteksten er roten av repoet:
#   docker build -f apps/app/Dockerfile .
# GitHub Actions bygger det for serverens arkitektur (jobben `build-app` i ci.yml) og
# legger det i det private registeret ghcr.io. Serveren bygger aldri selv; Coolify
# henter bare bildet. Ingen hemmeligheter trengs eller havner i bildet: alt fra
# miljøet leses når containeren starter.

FROM node:24.22.3-bookworm-slim AS build
WORKDIR /repo
# Personsøket kjører på CPU; CUDA-filene til onnxruntime trengs ikke.
ENV TURBO_TELEMETRY_DISABLED=1 ONNXRUNTIME_NODE_INSTALL=skip SEARCH_MODEL_DIR=/repo/.data/models
RUN corepack enable
# Pakkene lastes ned i et eget lag som bare bygges på nytt når låsefila endres.
# Vanlige deployer hopper derfor over nedlastingen.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
# Bare appen og pakkene den bruker, ikke nettsiden (Astro, Wrangler).
RUN pnpm install --offline --frozen-lockfile --filter "@esaf/app..." --filter "@esaf/core..."
RUN pnpm --filter @esaf/app build
# Embedding-modellene til personsøket legges i bildet, så serveren aldri laster ned noe.
RUN --mount=type=cache,id=esaf-search-models,target=/cache/models \
  SEARCH_MODEL_DIR=/cache/models pnpm search:download-model \
  && mkdir -p /repo/.data \
  && cp -R /cache/models /repo/.data/models

FROM node:24.22.3-bookworm-slim
ENV NODE_ENV=production PORT=3000 SEARCH_MODEL_DIR=/repo/.data/models
# Coolifys helsesjekk kjører curl eller wget inne i containeren; slim-bildet har ingen av dem.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
# Hele arbeidsområdet følger med, slik at migrering og admin-verktøy
# (`pnpm admin:grant`, `pnpm profiles:import`) kan kjøres i containeren.
COPY --from=build --chown=node:node /repo /repo
# pnpm lastes ned nå, ikke første gang noen kjører et verktøy i containeren.
RUN corepack enable && su node -c "pnpm --version"
USER node
EXPOSE 3000
# Committen bildet er bygget fra. Vises i /api/health, så deployen kan se at den nye versjonen svarer.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Migreringer kjøres før serveren starter. Feiler de, starter ikke den nye
# versjonen, og Coolify lar den forrige kjøre videre.
CMD ["sh", "-c", "cd packages/db && node_modules/.bin/tsx src/migrate.ts && cd /repo && exec node apps/app/.output/server/index.mjs"]

# Debian slim plutôt qu'Alpine : glibc permet l'extension SAM2/torch CPU.
# Pas de torch ni de modèle dans l'image de base.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
# Le lockfile est versionné : npm ci garantit la même arborescence de dépendances.
COPY package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
# L'interface visuelle : ses dépendances sont propres au dossier web/ et ne partent pas dans
# l'image finale, seul l'artefact web-dist/ y va.
RUN cd web && npm ci && npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
# Le paquet Debian ffmpeg fournit également ffprobe et le filtre subtitles.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-dejavu-core \
    && ffmpeg -version && ffprobe -version \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /work && chown node:node /work
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# Le pont Python de SAM2 : src/tools/sam2.ts le cherche en ../../python/sam2_runner.py depuis
# dist/tools. Sans cette copie, les sept outils sam2 échouent même sous le profil sam2.
COPY --from=build --chown=node:node /app/python ./python
COPY --from=build --chown=node:node /app/web-dist ./web-dist
ENV NODE_ENV=production ATELIER_WORK_DIR=/work
USER node
VOLUME ["/work"]
ENTRYPOINT ["node", "dist/index.js"]

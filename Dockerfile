# Debian slim plutôt qu'Alpine : glibc permet l'extension SAM2/torch CPU.
# Pas de torch ni de modèle dans l'image de base.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
# Le lockfile est versionné : npm ci garantit la même arborescence de dépendances.
COPY package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

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
ENV NODE_ENV=production ATELIER_WORK_DIR=/work
USER node
VOLUME ["/work"]
ENTRYPOINT ["node", "dist/index.js"]

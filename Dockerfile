# Debian slim rather than Alpine : glibc supports the SAM2/torch CPU extension.
# No torch or model in the base image.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
# The lockfile is version-controlled: npm ci guarantees the same dependency tree.
COPY package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
# The visual interface: its dependencies are specific to the web/ directory and do not go into
# l'image finale, seul l'artefact web-dist/ y va.
RUN cd web && npm ci && npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
# The Debian ffmpeg package also provides ffprobe and the subtitles filter.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-dejavu-core \
    && ffmpeg -version && ffprobe -version \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /work && chown node:node /work
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# The SAM2 Python bridge: src/tools/sam2.ts looks for it at ../../python/sam2_runner.py from
# dist/tools. Without this copy, all seven sam2 tools fail even under the sam2 profile.
COPY --from=build --chown=node:node /app/python ./python
COPY --from=build --chown=node:node /app/web-dist ./web-dist
ENV NODE_ENV=production ATELIER_WORK_DIR=/work
USER node
VOLUME ["/work"]
ENTRYPOINT ["node", "dist/index.js"]

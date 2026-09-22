# RoboRoute Nexus frontend image (MVP Phase 2).
#
# The base tag is pinned in docs/contracts/versions.md; "latest" is never used.
# Both stages share the same pinned Node image, so the stack introduces no extra
# image version beyond the three approved in Phase 0.
#
# `public/` carries the committed fixture GLB files, which Vite copies into `dist/`
# as `/assets/models/*.glb`. The generator that produced them lives in `tools/` and is
# not needed to build the image: the assets in the repository are already deterministic.
FROM node:24.21.0-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts vitest.config.ts index.html ./
COPY src ./src
COPY public ./public

RUN npm run build

FROM node:24.21.0-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY server ./server

USER node

EXPOSE 8080

CMD ["node", "server/static-server.mjs"]

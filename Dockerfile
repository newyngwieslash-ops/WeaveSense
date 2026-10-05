FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG SOURCE_SHA=unversioned
LABEL org.opencontainers.image.revision=$SOURCE_SHA
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV VITE_AUTH_ENABLED=false
RUN node scripts/readiness-offline.mjs -- npm run pack:source && node scripts/readiness-offline.mjs -- npm run build
# Runtime-only production gate (T02): declared *after* the build so image builds
# stay database-free, while `npm start` in this image refuses to serve without a
# DATABASE_URL instead of silently writing to the in-memory PGLite fallback.
ENV LOOM_RUNTIME_MODE=production
EXPOSE 8080
CMD ["npm", "run", "start"]

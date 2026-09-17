FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV VITE_AUTH_ENABLED=false
RUN npm run build
# Runtime-only production gate (T02): declared *after* the build so image builds
# stay database-free, while `npm start` in this image refuses to serve without a
# DATABASE_URL instead of silently writing to the in-memory PGLite fallback.
ENV LOOM_RUNTIME_MODE=production
EXPOSE 8080
CMD ["npm", "run", "start"]

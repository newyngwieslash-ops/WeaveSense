FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV VITE_AUTH_ENABLED=false
RUN npm run build
EXPOSE 8080
CMD ["npm", "run", "start"]

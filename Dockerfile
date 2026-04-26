# ─── Stage 1: dependencies ───────────────────────────
FROM node:20-slim AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci --frozen-lockfile

# ─── Stage 2: build ───────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ─── Stage 3: production ──────────────────────────────
FROM node:20-slim AS production
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --frozen-lockfile --omit=dev

COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/server.js"]

# ─── Stage 4: development (hot-reload via tsx) ────────
FROM node:20-slim AS development
WORKDIR /app

ENV NODE_ENV=development

# Install all deps including devDependencies
COPY package*.json ./
RUN npm ci --frozen-lockfile

COPY . .

EXPOSE 3000
CMD ["npm", "run", "dev"]

FROM node:22-alpine AS builder

WORKDIR /app

# Solo manifests primero (cache layer)
COPY services/aicos-quota-manager/package.json ./services/aicos-quota-manager/
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Install deps en el workspace del servicio (no necesitamos el resto del monorepo)
RUN pnpm install --filter @aicos/quota-manager --frozen-lockfile

COPY services/aicos-quota-manager/tsconfig.json services/aicos-quota-manager/tsup.config.ts ./services/aicos-quota-manager/
COPY services/aicos-quota-manager/src ./services/aicos-quota-manager/src

RUN cd services/aicos-quota-manager && pnpm build

# Deploy a un folder plano con deps prod resueltas (sin symlinks pnpm)
RUN pnpm --filter @aicos/quota-manager deploy --prod /deploy

# ──────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

RUN addgroup -g 1001 aicos && adduser -u 1001 -G aicos -s /bin/sh -D aicos \
  && apk add --no-cache wget

COPY --from=builder --chown=aicos:aicos /deploy ./

USER aicos

ENV NODE_ENV=production
ENV QUOTA_PORT=7001
EXPOSE 7001

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O- http://localhost:7001/health || exit 1

CMD ["node", "dist/index.js", "--serve"]

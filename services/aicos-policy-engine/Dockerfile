FROM node:22-alpine AS builder

WORKDIR /app

COPY services/aicos-policy-engine/package.json ./services/aicos-policy-engine/
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

RUN pnpm install --filter @aicos/policy-engine --frozen-lockfile

COPY services/aicos-policy-engine/tsconfig.json services/aicos-policy-engine/tsup.config.ts ./services/aicos-policy-engine/
COPY services/aicos-policy-engine/src ./services/aicos-policy-engine/src

RUN cd services/aicos-policy-engine && pnpm build

RUN pnpm --filter @aicos/policy-engine deploy --prod /deploy

FROM node:22-alpine AS runtime
WORKDIR /app
RUN addgroup -g 1001 aicos && adduser -u 1001 -G aicos -s /bin/sh -D aicos \
  && apk add --no-cache wget

COPY --from=builder --chown=aicos:aicos /deploy ./
USER aicos

ENV NODE_ENV=production
ENV POLICY_PORT=7002
EXPOSE 7002

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O- http://localhost:7002/health || exit 1

CMD ["node", "dist/index.js", "--serve"]

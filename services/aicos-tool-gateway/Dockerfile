FROM node:22-alpine AS builder
WORKDIR /app
COPY services/aicos-tool-gateway/package.json ./services/aicos-tool-gateway/
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
RUN pnpm install --filter @aicos/tool-gateway --frozen-lockfile
COPY services/aicos-tool-gateway/tsconfig.json services/aicos-tool-gateway/tsup.config.ts ./services/aicos-tool-gateway/
COPY services/aicos-tool-gateway/src ./services/aicos-tool-gateway/src
RUN cd services/aicos-tool-gateway && pnpm build
RUN pnpm --filter @aicos/tool-gateway deploy --prod /deploy

FROM node:22-alpine AS runtime
WORKDIR /app
# docker-cli for the docker tool (gateway proxies docker commands via spawned `docker`)
RUN addgroup -g 1001 aicos && adduser -u 1001 -G aicos -s /bin/sh -D aicos \
  && apk add --no-cache wget docker-cli
COPY --from=builder --chown=aicos:aicos /deploy ./
USER aicos
ENV NODE_ENV=production
ENV GATEWAY_PORT=7004
EXPOSE 7004
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O- http://localhost:7004/health || exit 1
CMD ["node", "dist/index.js", "--serve"]

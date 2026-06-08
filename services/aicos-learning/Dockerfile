FROM node:22-alpine AS builder
WORKDIR /app
COPY services/aicos-learning/package.json ./services/aicos-learning/
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
RUN pnpm install --filter @aicos/learning --frozen-lockfile
COPY services/aicos-learning/tsconfig.json services/aicos-learning/tsup.config.ts ./services/aicos-learning/
COPY services/aicos-learning/src ./services/aicos-learning/src
RUN cd services/aicos-learning && pnpm build
RUN pnpm --filter @aicos/learning deploy --prod /deploy

FROM node:22-alpine AS runtime
WORKDIR /app
RUN addgroup -g 1001 aicos && adduser -u 1001 -G aicos -s /bin/sh -D aicos \
  && apk add --no-cache wget
COPY --from=builder --chown=aicos:aicos /deploy ./
USER aicos
ENV NODE_ENV=production
ENV LEARNING_PORT=7003
EXPOSE 7003
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O- http://localhost:7003/health || exit 1
CMD ["node", "dist/index.js", "--serve"]

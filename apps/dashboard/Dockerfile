FROM node:22-alpine AS deps
WORKDIR /app

COPY apps/dashboard/package.json ./apps/dashboard/
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
RUN pnpm install --filter @aicos/dashboard --frozen-lockfile

FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/dashboard/node_modules ./apps/dashboard/node_modules
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/dashboard ./apps/dashboard

RUN cd apps/dashboard && pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 nextjs && adduser -u 1001 -G nextjs -s /bin/sh -D nextjs \
  && apk add --no-cache wget

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Next.js standalone output
COPY --from=builder --chown=nextjs:nextjs /app/apps/dashboard/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder --chown=nextjs:nextjs /app/apps/dashboard/public ./apps/dashboard/public 2>/dev/null || true

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:3000/api/health 2>&1 | grep -q "ok" || wget -q -O- http://localhost:3000/ | head -c 50 || exit 1

CMD ["node", "apps/dashboard/server.js"]

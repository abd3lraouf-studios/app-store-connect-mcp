# syntax=docker/dockerfile:1.7
#
# Two transports, two very different container shapes:
#
#   stdio  docker run -i --rm IMAGE
#          -i is mandatory (stdin must stay open) and -t must NOT be used,
#          because a TTY mangles the JSON-RPC stream. No EXPOSE, and no
#          HEALTHCHECK: there is no port, and a probe writing to stdout would
#          corrupt the protocol channel.
#
#   http   docker run -p 127.0.0.1:8787:8787 -e ASC_HTTP_TOKEN=... IMAGE \
#            --transport http --host 0.0.0.0
#          Binding 0.0.0.0 inside the container is right; publish it to
#          loopback on the host. The container boundary is not the security
#          boundary — the Origin/Host guards and bearer token still apply.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps  --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/dist        ./dist
COPY --from=build --chown=nonroot:nonroot /app/spec        ./spec
COPY --chown=nonroot:nonroot package.json ./
USER nonroot

# The distroless nodejs image already has "node" as its ENTRYPOINT.
CMD ["dist/index.js"]

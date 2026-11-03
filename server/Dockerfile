# Build from the repository root: docker build -f server/Dockerfile -t stupid .
FROM node:24-bookworm-slim AS web
WORKDIR /build
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
RUN npm ci
COPY frontend frontend
RUN npm run build && mkdir -p /data

FROM rust:1.95-bookworm AS server
WORKDIR /build
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src src
RUN cargo build --release --locked

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=server /build/target/release/stupid-server /stupid-server
COPY --from=web /build/frontend/dist /app/dist
# An empty data folder owned by the nonroot user, so a fresh volume is writable.
COPY --from=web --chown=nonroot:nonroot /data /home/nonroot/data
# Settings come from the host's environment (STUPID_*); mount a volume at /home/nonroot/data to keep the database.
ENV STUPID_STATIC_DIR=/app/dist \
    STUPID_DATA_DIR=/home/nonroot/data \
    STUPID_BIND=0.0.0.0:8000 \
    RUST_LOG=info
EXPOSE 8000
CMD ["/stupid-server"]

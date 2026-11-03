# Build from the repository root: docker build -f server/Dockerfile -t secnd .
FROM node:24-bookworm-slim AS web
WORKDIR /build
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
RUN npm ci
COPY frontend frontend
RUN npm run build

FROM rust:1.95-bookworm AS server
WORKDIR /build
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src src
RUN cargo build --release --locked

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=server /build/target/release/secnd-server /secnd-server
COPY --from=web /build/frontend/dist /app/dist
# Settings come from the host's environment (SECND_*); mount a volume at /home/nonroot/data to keep the database.
ENV SECND_STATIC_DIR=/app/dist \
    SECND_DATA_DIR=/home/nonroot/data \
    SECND_BIND=0.0.0.0:8000 \
    RUST_LOG=info
EXPOSE 8000
CMD ["/secnd-server"]

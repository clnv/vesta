FROM node:26.5-trixie AS web-assets
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
RUN npm run build

FROM golang:1.26.5-trixie AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/web ./cmd/web
COPY internal/webui/*.go ./internal/webui/
COPY --from=web-assets /src/internal/webui/dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/vesta-web ./cmd/web

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /out/vesta-web /usr/local/bin/vesta-web
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/vesta-web"]
CMD ["-api-url", "http://127.0.0.1:8080"]

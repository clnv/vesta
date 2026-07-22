FROM node:24-alpine AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
RUN npm run build

FROM golang:1.26-alpine AS api
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY --from=web /src/internal/webui/dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/vesta ./cmd/vesta

FROM alpine:3.24
RUN apk add --no-cache ca-certificates \
    && addgroup -S -g 10001 vesta \
    && adduser -S -D -H -u 10001 -G vesta vesta
COPY --from=api /out/vesta /usr/local/bin/vesta
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["vesta"]
CMD ["-config", "/etc/vesta/config.yml"]

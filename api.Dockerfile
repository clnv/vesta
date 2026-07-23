FROM golang:1.26.5-trixie AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/api ./cmd/api
COPY internal ./internal
RUN mkdir -p /out/data \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/vesta-api ./cmd/api

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /out/vesta-api /usr/local/bin/vesta-api
COPY --from=build --chown=65532:65532 /out/data /var/lib/vesta
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/vesta-api"]
CMD ["-config", "/etc/vesta/config.yml"]

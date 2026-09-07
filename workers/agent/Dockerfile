FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ENV CGO_ENABLED=0
RUN go build -o /out/agent ./cmd/agent

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/agent /app/agent
COPY skills /app/skills
COPY config /app/config
USER nonroot
EXPOSE 8791
ENTRYPOINT ["/app/agent"]

FROM golang:1.22-bookworm

ENV CGO_ENABLED=0 \
    GOFLAGS=-mod=mod

WORKDIR /app

COPY go.mod ./
COPY runner.go ./
RUN go build -o /usr/local/bin/go-runner .

# Warm the build cache so the first `go run` of a generated script is fast.
RUN go build std

# Default: watch the generated dir shared with the node-runner service.
CMD ["go-runner", "--watch", "/generated"]

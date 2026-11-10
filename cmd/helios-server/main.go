package main

import (
	"context"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"heliosgen/internal/bridgecli"
	"heliosgen/internal/server"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "cli" {
		os.Exit(bridgecli.Run(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}
	address := flag.String("listen", "127.0.0.1:41731", "Loopback listen address")
	data := flag.String("data", os.Getenv("HELIOS_DATA_DIR"), "Writable data directory (required)")
	media := flag.String("media", os.Getenv("HELIOS_MEDIA_DIR"), "Media directory")
	assets := flag.String("assets", "desktop/resources/frontend", "Static frontend directory")
	version := flag.String("version", "1.2.4", "Application version")
	flag.Parse()
	host, _, err := net.SplitHostPort(*address)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		log.Fatal("Server must listen on a loopback IP")
	}
	backend, err := server.New(server.Config{DataDir: *data, MediaDir: *media, AssetDir: *assets, Version: *version})
	if err != nil {
		log.Fatal(err)
	}
	defer backend.Close()
	listener, err := net.Listen("tcp", *address)
	if err != nil {
		log.Fatal(err)
	}
	if err = backend.SetIntegrationEndpoint("http://" + listener.Addr().String()); err != nil {
		log.Fatal(err)
	}
	httpServer := &http.Server{Handler: backend, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	log.Printf("HeliosGen Go server: http://%s", listener.Addr())
	if err = httpServer.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Print(err)
	}
}

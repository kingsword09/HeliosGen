package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/egoist/mygo"
	"heliosgen/internal/server"
)

func startGoServer(assets string, focus func()) (*serverProcess, string, error) {
	data, err := dataDirectory()
	if err != nil {
		return nil, "", err
	}
	media := os.Getenv("HELIOS_MEDIA_DIR")
	if media == "" {
		media = filepath.Join(data, "generated")
	}
	if err = os.MkdirAll(data, 0700); err != nil {
		return nil, "", err
	}
	logs, err := os.OpenFile(filepath.Join(data, "desktop-server.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return nil, "", err
	}
	if err = os.Setenv("PATH", shellPath()); err != nil {
		logs.Close()
		return nil, "", err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:41730")
	if err != nil {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
	}
	if err != nil {
		logs.Close()
		return nil, "", err
	}
	backend, err := server.New(server.Config{DataDir: data, MediaDir: media, AssetDir: assets, Version: mygo.App.Version(), Focus: focus, ChooseConfigPath: func(name string) (string, error) {
		return mygo.Dialog.Save(mygo.SaveDialogOptions{Title: "导出 HeliosGen 配置", DefaultPath: name, CreateDirectories: true, Filters: []mygo.FileFilter{{Name: "HeliosGen 配置", Extensions: []string{"json"}}}})
	}})
	if err != nil {
		listener.Close()
		logs.Close()
		return nil, "", err
	}
	httpServer := &http.Server{Handler: backend, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, ErrorLog: log.New(logs, "", log.LstdFlags)}
	process := &serverProcess{logs: logs, done: make(chan error, 1)}
	process.cancel = func() { _ = httpServer.Close(); _ = backend.Close() }
	if err = backend.SetIntegrationEndpoint(fmt.Sprintf("http://%s", listener.Addr())); err != nil {
		process.cancel()
		logs.Close()
		return nil, "", err
	}
	go func() { process.done <- httpServer.Serve(listener) }()
	target := fmt.Sprintf("http://%s", listener.Addr())
	fmt.Fprintf(logs, "%s Go backend listening at %s\n", time.Now().Format(time.RFC3339), target)
	return process, target, nil
}

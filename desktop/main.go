package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

const identifier = "cash.sdd.helios.desktop"

type serverProcess struct {
	command *exec.Cmd
	cancel  context.CancelFunc
	logs    *os.File
	done    chan error
	once    sync.Once
}

func dataDirectory() (string, error) {
	if path := os.Getenv("HELIOS_DATA_DIR"); path != "" {
		return path, nil
	}
	var base string
	var err error
	if runtime.GOOS == "linux" {
		base = os.Getenv("XDG_DATA_HOME")
		if base == "" {
			home, homeErr := os.UserHomeDir()
			if homeErr != nil {
				return "", homeErr
			}
			base = filepath.Join(home, ".local", "share")
		}
	} else {
		base, err = os.UserConfigDir()
		if err != nil {
			return "", err
		}
	}
	return filepath.Join(base, identifier), nil
}

func shellPath() string {
	if runtime.GOOS == "windows" {
		return os.Getenv("PATH")
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, shell, "-l", "-c", "printf '%s' \"$PATH\"").Output()
	if err != nil || len(output) == 0 {
		return os.Getenv("PATH")
	}
	return strings.TrimSpace(string(output))
}

func availablePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:41730")
	if err != nil {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
	}
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

func startServer() (*serverProcess, string, error) {
	resources, err := mygo.App.Path(mygo.PathResources)
	if err != nil {
		return nil, "", err
	}
	serverDir := filepath.Join(resources, "server")
	dataDir, err := dataDirectory()
	if err != nil {
		return nil, "", err
	}
	mediaDir := filepath.Join(dataDir, "generated")
	if err = os.MkdirAll(mediaDir, 0700); err != nil {
		return nil, "", err
	}
	logs, err := os.OpenFile(filepath.Join(dataDir, "desktop-server.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return nil, "", err
	}
	port, err := availablePort()
	if err != nil {
		logs.Close()
		return nil, "", err
	}
	node := "node"
	if runtime.GOOS == "windows" {
		node += ".exe"
	}
	ctx, cancel := context.WithCancel(context.Background())
	command := exec.CommandContext(ctx, filepath.Join(serverDir, "node-bin", node), "--disable-warning=ExperimentalWarning", "-r", filepath.Join(serverDir, "sidecar-guard.js"), filepath.Join(serverDir, "server.js"))
	command.Dir = serverDir
	command.Env = append(os.Environ(), "PORT="+strconv.Itoa(port), "HOSTNAME=127.0.0.1", "HELIOS_DATA_DIR="+dataDir, "HELIOS_MEDIA_DIR="+mediaDir, "PATH="+shellPath())
	command.Stdout = logs
	command.Stderr = logs
	if err = command.Start(); err != nil {
		cancel()
		logs.Close()
		return nil, "", err
	}
	process := &serverProcess{command: command, cancel: cancel, logs: logs, done: make(chan error, 1)}
	go func() { process.done <- command.Wait() }()
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	client := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case exit := <-process.done:
			process.stop()
			return nil, "", fmt.Errorf("desktop server stopped: %v; see %s", exit, logs.Name())
		default:
		}
		response, requestErr := client.Get(baseURL + "/api/health")
		if requestErr == nil {
			var health struct{ App string }
			decodeErr := json.NewDecoder(response.Body).Decode(&health)
			response.Body.Close()
			if decodeErr == nil && health.App == "HeliosGen" {
				return process, baseURL, nil
			}
		}
		time.Sleep(150 * time.Millisecond)
	}
	process.stop()
	return nil, "", errors.New("desktop server startup timed out; see " + logs.Name())
}

func (process *serverProcess) stop() {
	process.once.Do(func() {
		process.cancel()
		process.logs.Close()
	})
}

func main() {
	mygo.App.SetName("HeliosGen")
	if !mygo.App.RequestSingleInstanceLock() {
		return
	}
	var process *serverProcess
	var window *mygo.Window
	mygo.App.OnSecondInstance(func(_ []string, _ string) {
		if window != nil {
			window.Show()
			window.Focus()
		}
	})
	mygo.App.OnQuit(func() {
		if process != nil {
			process.stop()
		}
	})
	mygo.App.WhenReady(func() {
		target := os.Getenv("MYGO_DEV_URL")
		if target == "" {
			var err error
			process, target, err = startServer()
			if err != nil {
				log.Print(err)
				mygo.App.Quit()
				return
			}
		}
		window = mygo.NewWindow(mygo.WindowOptions{Title: "HeliosGen", URL: target, Width: 1400, Height: 900, MinWidth: 900, MinHeight: 600})
		window.OnClosed(func() { mygo.App.Quit() })
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

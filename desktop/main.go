package main

import (
	"context"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"heliosgen/internal/bridge"
	"heliosgen/internal/bridgecli"
)

const identifier = "cash.sdd.helios.desktop"

type serverProcess struct {
	cancel context.CancelFunc
	logs   *os.File
	done   chan error
	once   sync.Once
}

func dataDirectory() (string, error) {
	return bridge.DataDirectory()
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

func startServer(focus func()) (*serverProcess, string, error) {
	resources, err := mygo.App.Path(mygo.PathResources)
	if err != nil {
		return nil, "", err
	}
	return startGoServer(filepath.Join(resources, "frontend"), focus)
}

func (process *serverProcess) stop() {
	process.once.Do(func() {
		process.cancel()
		process.logs.Close()
	})
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "cli" {
		os.Exit(bridgecli.Run(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}
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
			process, target, err = startServer(func() {
				mygo.RunOnMain(func() {
					if window != nil {
						window.Show()
						window.Focus()
					}
				})
			})
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

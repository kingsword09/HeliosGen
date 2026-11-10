package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

func (backend *Server) videoOperation(request *http.Request) (any, error) {
	if err := method(request, "POST"); err != nil {
		return nil, err
	}
	fields, err := body(request)
	if err != nil {
		return nil, err
	}
	if !truth(fields["videoUrl"]) {
		return nil, bad("videoUrl is required")
	}
	trim := request.URL.Path == "/api/trim-video"
	if trim && (fields["startTime"] == nil || fields["endTime"] == nil) {
		return nil, bad("videoUrl, startTime and endTime are required")
	}
	start, end := number(fields["startTime"]), number(fields["endTime"])
	if trim && end <= start {
		return nil, bad("endTime must be greater than startTime")
	}
	ctx, cancel := context.WithTimeout(request.Context(), 2*time.Minute)
	defer cancel()
	buffer, contentType, err := backend.fetchMedia(ctx, text(fields["videoUrl"]), 500<<20)
	if err != nil {
		return nil, err
	}
	directory, err := os.MkdirTemp("", "helios-video-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(directory)
	input := filepath.Join(directory, "input.mp4")
	output := filepath.Join(directory, "output.mp4")
	if err = os.WriteFile(input, buffer, 0600); err != nil {
		return nil, err
	}
	args := []string{}
	if trim {
		args = []string{"-ss", fmt.Sprint(start), "-i", input, "-t", fmt.Sprint(end - start), "-c", "copy", "-avoid_negative_ts", "1", "-y", output}
		if !strings.HasPrefix(contentType, "video/") {
			contentType = "video/mp4"
		}
	} else {
		probe, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input).Output()
		if err != nil {
			return nil, fmt.Errorf("ffprobe: %w", err)
		}
		duration, parseErr := strconv.ParseFloat(strings.TrimSpace(string(probe)), 64)
		seek := max(0, number(fields["timeSeconds"]))
		if truth(fields["lastFrame"]) {
			seek = 0
			if parseErr == nil {
				seek = max(0, duration-0.1)
			}
		} else if parseErr == nil {
			seek = min(seek, max(0, duration-0.1))
		}
		output = filepath.Join(directory, "frame.jpg")
		contentType = "image/jpeg"
		args = []string{"-ss", fmt.Sprint(seek), "-i", input, "-frames:v", "1", "-q:v", "2", "-y", output}
	}
	if diagnostic, err := exec.CommandContext(ctx, "ffmpeg", args...).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("ffmpeg: %s: %w", diagnostic, err)
	}
	buffer, err = os.ReadFile(output)
	if err != nil {
		return nil, err
	}
	location, err := backend.uploadBuffer(buffer, contentType, "references")
	return Object{"cdnUrl": location}, err
}

func (backend *Server) openExternal(request *http.Request) (any, error) {
	if err := method(request, "POST"); err != nil {
		return nil, err
	}
	fields, err := body(request)
	if err != nil {
		return nil, bad("invalid url")
	}
	target, err := url.Parse(text(fields["url"]))
	if err != nil || target.Hostname() == "" {
		return nil, bad("invalid url")
	}
	if target.Scheme != "https" && target.Scheme != "http" {
		return nil, bad("unsupported protocol")
	}
	command, args := "xdg-open", []string{target.String()}
	if runtime.GOOS == "darwin" {
		command = "open"
	}
	if runtime.GOOS == "windows" {
		command = "rundll32"
		args = []string{"url.dll,FileProtocolHandler", target.String()}
	}
	child := exec.Command(command, args...)
	if err = child.Start(); err != nil {
		return nil, err
	}
	go func() { _ = child.Wait() }()
	return Object{"ok": true}, nil
}

func newerVersion(candidate, base string) bool {
	pattern := regexp.MustCompile(`(\d+)(?:\.(\d+))?(?:\.(\d+))?`)
	first, second := pattern.FindStringSubmatch(candidate), pattern.FindStringSubmatch(base)
	for index := 1; index <= 3; index++ {
		newer, older := float64(0), float64(0)
		if len(first) > index {
			newer = number(first[index])
		}
		if len(second) > index {
			older = number(second[index])
		}
		if newer != older {
			return newer > older
		}
	}
	return false
}

func (backend *Server) updateCheck(request *http.Request) (any, error) {
	if err := method(request, "GET"); err != nil {
		return nil, err
	}
	backend.updateMu.Lock()
	defer backend.updateMu.Unlock()
	if backend.updateCache != nil && time.Since(backend.updateAt) < time.Hour {
		return backend.updateCache, nil
	}
	version := backend.config.Version
	if version == "" {
		version = "0.0.0"
	}
	result := Object{"updateAvailable": false, "currentVersion": version}
	ctx, cancel := context.WithTimeout(request.Context(), 10*time.Second)
	defer cancel()
	outgoing, _ := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/repos/SegFault42/HeliosGen/releases/latest", nil)
	outgoing.Header.Set("Accept", "application/vnd.github+json")
	outgoing.Header.Set("User-Agent", "HeliosGen-Desktop/"+version)
	response, err := backend.client.Do(outgoing)
	force := os.Getenv("NEXT_PUBLIC_UPDATE_CHECK_FORCE") == "1"
	if err == nil {
		defer response.Body.Close()
		if response.StatusCode == 200 {
			var release Object
			if json.NewDecoder(response.Body).Decode(&release) == nil {
				tag := strings.TrimSpace(text(release["tag_name"]))
				if tag != "" && !truth(release["draft"]) && (force || !truth(release["prerelease"]) && newerVersion(tag, version)) {
					name := strings.TrimSpace(text(release["name"]))
					if name == "" {
						name = tag
					}
					result = Object{"updateAvailable": true, "currentVersion": version, "latestVersion": tag, "name": name, "notes": strings.TrimSpace(text(release["body"])), "url": fallback(release["html_url"], "https://github.com/SegFault42/HeliosGen/releases/latest")}
					if release["published_at"] != nil {
						result["publishedAt"] = release["published_at"]
					}
				}
			}
		} else if force {
			result = Object{"updateAvailable": true, "currentVersion": version, "latestVersion": "v0.0.0-preview", "name": "Preview (forced)", "notes": "This is a preview of the update banner and changelog modal.\n\n- Shown because NEXT_PUBLIC_UPDATE_CHECK_FORCE=1.\n- The real check compares the GitHub latest release against the\n  bundled version and stays hidden when you're current.", "url": "https://github.com/SegFault42/HeliosGen/releases/latest"}
		}
	}
	backend.updateCache = result
	backend.updateAt = time.Now()
	return result, nil
}

func codexAuthExists() bool {
	directory := os.Getenv("CODEX_HOME")
	if directory == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return false
		}
		directory = filepath.Join(home, ".codex")
	}
	_, err := os.Stat(filepath.Join(directory, "auth.json"))
	return err == nil
}

func (backend *Server) codexStatus(request *http.Request) (any, error) {
	if err := method(request, "GET"); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(request.Context(), 10*time.Second)
	defer cancel()
	installed := exec.CommandContext(ctx, "codex-imagegen", "--help").Run() == nil
	auth := codexAuthExists()
	return Object{"installed": installed, "authFound": auth, "ready": installed && auth}, nil
}

func (backend *Server) loginState() Object {
	buffer, err := os.ReadFile(filepath.Join(backend.config.DataDir, ".codex-login-store.json"))
	var result Object
	if err != nil || json.Unmarshal(buffer, &result) != nil || result == nil {
		return Object{"status": "idle"}
	}
	return result
}

func (backend *Server) saveLoginState(value Object) error {
	filename := filepath.Join(backend.config.DataDir, ".codex-login-store.json")
	if err := os.WriteFile(filename+".tmp", []byte(jsonText(value)), 0600); err != nil {
		return err
	}
	return os.Rename(filename+".tmp", filename)
}

type loginOutput struct {
	backend   *Server
	buffer    string
	ready     chan struct{}
	announced bool
}

func (output *loginOutput) Write(buffer []byte) (int, error) {
	output.backend.loginMu.Lock()
	defer output.backend.loginMu.Unlock()
	output.buffer += string(buffer)
	if len(output.buffer) > 1<<20 {
		output.buffer = output.buffer[len(output.buffer)-(1<<20):]
	}
	clean := regexp.MustCompile(`\x1b\[[0-9;]*m`).ReplaceAllString(output.buffer, "")
	target := regexp.MustCompile(`https://\S+`).FindString(clean)
	code := regexp.MustCompile(`\b[A-Z0-9]{4}-[A-Z0-9]{4,8}\b`).FindString(clean)
	if !output.announced && target != "" && code != "" {
		_ = output.backend.saveLoginState(Object{"status": "pending", "url": target, "code": code, "startedAt": time.Now().UnixMilli()})
		output.announced = true
		close(output.ready)
	}
	return len(buffer), nil
}

func (backend *Server) confirmCodexLogin(ctx context.Context) bool {
	for attempt := 0; attempt < 6 && ctx.Err() == nil; attempt++ {
		if codexAuthExists() {
			return true
		}
		probe, cancel := context.WithTimeout(ctx, 10*time.Second)
		output, _ := exec.CommandContext(probe, "codex", "login", "status").Output()
		cancel()
		if regexp.MustCompile(`(?im)^logged in`).MatchString(strings.TrimSpace(string(output))) {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(time.Second):
		}
	}
	return false
}

func (backend *Server) codexLogin(request *http.Request) (any, error) {
	if request.Method != "GET" && request.Method != "POST" {
		return nil, &HTTPError{405, "Method not allowed"}
	}
	backend.loginMu.Lock()
	current := backend.loginState()
	if request.Method == "GET" {
		backend.loginMu.Unlock()
		return current, nil
	}
	if current["status"] == "pending" && time.Now().UnixMilli()-int64(number(current["startedAt"])) < int64(16*time.Minute/time.Millisecond) {
		backend.loginMu.Unlock()
		return current, nil
	}
	if backend.loginCancel != nil {
		ready := backend.loginReady
		backend.loginMu.Unlock()
		select {
		case <-ready:
			backend.loginMu.Lock()
			current = backend.loginState()
			backend.loginMu.Unlock()
			return current, nil
		case <-request.Context().Done():
			return nil, request.Context().Err()
		case <-time.After(10 * time.Second):
			return Object{"status": "error", "error": "Timed out waiting for codex login to print a device code."}, nil
		}
	}
	if backend.ctx.Err() != nil {
		backend.loginMu.Unlock()
		return nil, errors.New("Server is shutting down")
	}
	ctx, cancel := context.WithTimeout(backend.ctx, 16*time.Minute)
	ready := make(chan struct{})
	backend.loginCancel = cancel
	backend.loginReady = ready
	output := &loginOutput{backend: backend, ready: ready}
	command := exec.CommandContext(ctx, "codex", "login", "--device-auth")
	command.Stdout = output
	command.Stderr = output
	if !backend.claimJob("codex-login") {
		cancel()
		backend.loginCancel = nil
		backend.loginMu.Unlock()
		return nil, errors.New("Server is shutting down")
	}
	if err := command.Start(); err != nil {
		backend.releaseJob("codex-login")
		cancel()
		backend.loginCancel = nil
		state := Object{"status": "error", "error": fmt.Sprintf("codex spawn failed: %v — is it installed and on PATH?", err)}
		_ = backend.saveLoginState(state)
		backend.loginMu.Unlock()
		return state, nil
	}
	backend.loginMu.Unlock()
	go func() {
		defer backend.releaseJob("codex-login")
		defer cancel()
		err := command.Wait()
		loggedIn := backend.confirmCodexLogin(ctx)
		backend.loginMu.Lock()
		defer backend.loginMu.Unlock()
		backend.loginCancel = nil
		if backend.ctx.Err() != nil {
			if !output.announced {
				output.announced = true
				close(ready)
			}
			return
		}
		state := Object{"status": "success"}
		if !loggedIn {
			clean := strings.TrimSpace(regexp.MustCompile(`\x1b\[[0-9;]*m`).ReplaceAllString(output.buffer, ""))
			if len(clean) > 300 {
				clean = clean[len(clean)-300:]
			}
			if clean == "" {
				clean = fmt.Sprintf("codex login exited: %v", err)
			}
			state = Object{"status": "error", "error": clean}
		}
		_ = backend.saveLoginState(state)
		if !output.announced {
			output.announced = true
			close(ready)
		}
	}()
	select {
	case <-ready:
		backend.loginMu.Lock()
		current = backend.loginState()
		backend.loginMu.Unlock()
		return current, nil
	case <-request.Context().Done():
		return nil, request.Context().Err()
	case <-time.After(10 * time.Second):
		return Object{"status": "error", "error": "Timed out waiting for codex login to print a device code."}, nil
	}
}

func finite(value float64) bool { return !math.IsInf(value, 0) && !math.IsNaN(value) }

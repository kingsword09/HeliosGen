package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Object map[string]any

type Config struct {
	DataDir          string
	MediaDir         string
	AssetDir         string
	Version          string
	Client           *http.Client
	Focus            func()
	ChooseConfigPath func(string) (string, error)
}

type Server struct {
	config               Config
	db                   *sql.DB
	client               *http.Client
	ctx                  context.Context
	cancel               context.CancelFunc
	mu                   sync.Mutex
	jobMu                sync.Mutex
	running              map[string]bool
	events               map[chan Object]struct{}
	workers              sync.WaitGroup
	catalogMu            sync.Mutex
	loginMu              sync.Mutex
	loginCancel          context.CancelFunc
	loginReady           chan struct{}
	updateMu             sync.Mutex
	updateCache          Object
	updateAt             time.Time
	integrationMu        sync.Mutex
	integrationEventMu   sync.Mutex
	integrationListeners map[chan Object]struct{}
	integrationEndpoint  string
	integrationInstance  string
}

type HTTPError struct {
	Status  int
	Message string
}

func (failure *HTTPError) Error() string { return failure.Message }

func bad(message string) error { return &HTTPError{http.StatusBadRequest, message} }

func New(config Config) (*Server, error) {
	if config.DataDir == "" {
		return nil, errors.New("A writable data directory is required")
	}
	if config.MediaDir == "" {
		config.MediaDir = filepath.Join(config.DataDir, "generated")
	}
	for _, directory := range []string{config.DataDir, config.MediaDir} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			return nil, err
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	client := config.Client
	if client == nil {
		client = &http.Client{Transport: http.DefaultTransport.(*http.Transport).Clone()}
	}
	backend := &Server{config: config, client: client, ctx: ctx, cancel: cancel, running: map[string]bool{}, events: map[chan Object]struct{}{}}
	if err := backend.openDatabase(); err != nil {
		cancel()
		return nil, err
	}
	backend.integrationListeners = map[chan Object]struct{}{}
	backend.integrationInstance = uuid()
	return backend, nil
}

func (backend *Server) Close() error {
	backend.unpublishIntegration()
	backend.jobMu.Lock()
	backend.cancel()
	backend.jobMu.Unlock()
	backend.workers.Wait()
	return backend.db.Close()
}

func (backend *Server) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	defer func() {
		if failure := recover(); failure != nil {
			log.Printf("HTTP handler panic: %v", failure)
			writeError(response, fmt.Errorf("Internal server error"))
		}
	}()
	host := request.Host
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		host = parsed
	}
	if host != "localhost" && (net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback()) {
		http.Error(response, "Forbidden", 403)
		return
	}
	if origin := request.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || (parsed.Hostname() != "localhost" && (net.ParseIP(parsed.Hostname()) == nil || !net.ParseIP(parsed.Hostname()).IsLoopback())) {
			http.Error(response, "Forbidden", 403)
			return
		}
	}
	response.Header().Set("X-Content-Type-Options", "nosniff")
	path := request.URL.Path
	if path == "/api/settings/integrations" {
		backend.integrationAdmin(response, request)
		return
	}
	if path == "/api/settings/integrations/reference" {
		backend.integrationAdminReference(response, request)
		return
	}
	if path == "/api/integration-events" {
		backend.integrationEvents(response, request)
		return
	}
	if strings.HasPrefix(path, "/api/integrations/v1/") {
		backend.integrationAPI(response, request)
		return
	}
	if strings.HasPrefix(path, "/generated/") {
		backend.serveMedia(response, request)
		return
	}
	if path == "/api/download" {
		backend.download(response, request)
		return
	}
	if path == "/api/thumbnail" || path == "/_next/image" {
		backend.thumbnail(response, request)
		return
	}
	if path == "/api/job-stream" {
		backend.jobStream(response, request)
		return
	}
	if path == "/api/assistant" {
		backend.assistant(response, request)
		return
	}
	if !strings.HasPrefix(path, "/api/") {
		backend.serveAssets(response, request)
		return
	}
	var result any
	var err error
	switch path {
	case "/api/health":
		result = Object{"app": "HeliosGen"}
	case "/api/workflows":
		result, err = backend.workflows(request)
	case "/api/gallery":
		result, err = backend.gallery(request)
	case "/api/assets":
		result, err = backend.assets(request)
	case "/api/settings/transfer":
		result, err = backend.transferSettings(request)
	case "/api/folders":
		result, err = backend.folders(request)
	case "/api/folder-items":
		result, err = backend.folderItems(request)
	case "/api/lookup-asset":
		result, err = backend.lookupAsset(request)
	case "/api/upload", "/api/upload-asset", "/api/upload-video", "/api/fetch-url":
		result, err = backend.upload(request)
	case "/api/settings/provider":
		result, err = backend.providerSettings(request)
	case "/api/settings/provider/models":
		result, err = backend.providerModels(request)
	case "/api/settings/provider/model-catalog":
		result, err = backend.modelCatalog(request)
	case "/api/settings/azure-key":
		result, err = backend.azureKey(request)
	case "/api/settings/codex-login":
		result, err = backend.codexLogin(request)
	case "/api/settings/codex-status":
		result, err = backend.codexStatus(request)
	case "/api/generate", "/api/generate-image", "/api/generate-video":
		result, err = backend.generate(request)
	case "/api/job-status":
		result, err = backend.jobStatus(request)
	case "/api/extract-frame", "/api/trim-video":
		result, err = backend.videoOperation(request)
	case "/api/update-check":
		result, err = backend.updateCheck(request)
	case "/api/open-external":
		result, err = backend.openExternal(request)
	default:
		if strings.HasPrefix(path, "/api/folders/") {
			result, err = backend.folder(request)
		} else {
			err = &HTTPError{404, "Not found"}
		}
	}
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, 200, result)
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	if err := json.NewEncoder(response).Encode(value); err != nil {
		log.Print(err)
	}
}

func writeError(response http.ResponseWriter, err error) {
	status := 500
	var failure *HTTPError
	if errors.As(err, &failure) {
		status = failure.Status
	}
	writeJSON(response, status, Object{"error": err.Error()})
}

func body(request *http.Request) (Object, error) {
	decoder := json.NewDecoder(io.LimitReader(request.Body, 150<<20))
	decoder.UseNumber()
	var value Object
	if err := decoder.Decode(&value); err != nil {
		return nil, bad("invalid JSON")
	}
	if value == nil {
		return nil, bad("invalid JSON")
	}
	return value, nil
}

func text(value any) string {
	if value == nil {
		return ""
	}
	if result, ok := value.(string); ok {
		return result
	}
	return fmt.Sprint(value)
}

func number(value any) float64 { result, _ := strconv.ParseFloat(text(value), 64); return result }
func truth(value any) bool {
	if value == nil {
		return false
	}
	if result, ok := value.(bool); ok {
		return result
	}
	if result, ok := value.(string); ok {
		return result != ""
	}
	if _, ok := value.(map[string]any); ok {
		return true
	}
	if _, ok := value.(Object); ok {
		return true
	}
	if _, ok := value.([]any); ok {
		return true
	}
	return number(value) != 0
}
func object(value any) Object {
	if result, ok := value.(Object); ok {
		return result
	}
	if result, ok := value.(map[string]any); ok {
		return Object(result)
	}
	return Object{}
}
func array(value any) []any {
	if result, ok := value.([]any); ok {
		return result
	}
	return []any{}
}
func jsonText(value any) string { encoded, _ := json.Marshal(value); return string(encoded) }
func clone(value Object) Object {
	var result Object
	_ = json.Unmarshal([]byte(jsonText(value)), &result)
	if result == nil {
		return Object{}
	}
	return result
}
func fallback(value any, alternative any) any {
	if value == nil {
		return alternative
	}
	return value
}
func now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
func method(request *http.Request, expected string) error {
	if request.Method != expected {
		return &HTTPError{405, "Method not allowed"}
	}
	return nil
}

func (backend *Server) serveAssets(response http.ResponseWriter, request *http.Request) {
	if request.Method != "GET" && request.Method != "HEAD" {
		http.Error(response, "Method not allowed", 405)
		return
	}
	if backend.config.AssetDir == "" {
		http.NotFound(response, request)
		return
	}
	filename := filepath.Join(backend.config.AssetDir, filepath.FromSlash(strings.TrimPrefix(request.URL.Path, "/")))
	if !within(backend.config.AssetDir, filename) {
		http.Error(response, "Forbidden", 403)
		return
	}
	info, err := os.Stat(filename)
	if err != nil || info.IsDir() {
		if filepath.Ext(request.URL.Path) != "" {
			http.NotFound(response, request)
			return
		}
		filename = filepath.Join(backend.config.AssetDir, "index.html")
	}
	if strings.Contains(request.URL.Path, "/assets/") {
		response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		response.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeFile(response, request, filename)
}

func within(root, filename string) bool {
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	absoluteFile, err := filepath.Abs(filename)
	if err != nil {
		return false
	}
	relative, err := filepath.Rel(absoluteRoot, absoluteFile)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return false
	}
	actualRoot, err := filepath.EvalSymlinks(absoluteRoot)
	if err != nil {
		return false
	}
	ancestor := absoluteFile
	for {
		actual, failure := filepath.EvalSymlinks(ancestor)
		if failure == nil {
			suffix, failure := filepath.Rel(ancestor, absoluteFile)
			if failure != nil {
				return false
			}
			relative, failure = filepath.Rel(actualRoot, filepath.Join(actual, suffix))
			return failure == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
		}
		if !os.IsNotExist(failure) || ancestor == filepath.Dir(ancestor) {
			return false
		}
		ancestor = filepath.Dir(ancestor)
	}
}

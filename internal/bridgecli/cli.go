package bridgecli

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"heliosgen/internal/bridge"
)

type client struct {
	endpoint   bridge.Endpoint
	credential bridge.Credential
	http       *http.Client
}

const usage = `HeliosGen local image tools (JSON output)

helios [--client CONNECTION_ID] [--data-dir DIRECTORY] COMMAND
  connections                              List local connection IDs
  models                                   List enabled configured image models
  reference import --file PATH              Import a reference image
  image submit --request JSON_FILE           Submit an image request; '-' reads stdin
  job get JOB_ID                            Read a job and its outputs
  job wait JOB_ID --timeout 120              Wait without cancelling or resubmitting
  job download JOB_ID --output PATH          Save an original image (--index 0, --force)
  job open JOB_ID                           Show the result in Helios
  jobs watch                                Watch jobs in a dedicated terminal

The application must be running and external connections enabled.
Request JSON: requestId, prompt, optional modelId/aspectRatio/quality/referenceIds/source.
Use source.name for the calling agent, e.g. codex, claude-code, opencode or pi.
Rex session/block context is attached independently when available; Rex is a terminal
environment, not an agent identity. Source is informational; connection credentials
control authorization. No provider keys are exposed.
`

func Run(arguments []string, input io.Reader, output, errorOutput io.Writer) int {
	code, err := run(arguments, input, output, errorOutput)
	if err != nil {
		_ = json.NewEncoder(errorOutput).Encode(map[string]any{"error": err.Error()})
		if code == 0 {
			code = 1
		}
	}
	return code
}

func run(arguments []string, input io.Reader, output, errorOutput io.Writer) (int, error) {
	root := flag.NewFlagSet("helios", flag.ContinueOnError)
	root.SetOutput(errorOutput)
	connection := root.String("client", "", "Connection ID")
	data := root.String("data-dir", "", "Helios data directory")
	if len(arguments) == 0 || arguments[0] == "--help" || arguments[0] == "help" || arguments[0] == "-h" {
		_, err := io.WriteString(output, usage)
		return 0, err
	}
	if err := root.Parse(arguments); err != nil {
		return 1, err
	}
	args := root.Args()
	if len(args) == 0 {
		_, err := io.WriteString(output, usage)
		return 0, err
	}
	if *data == "" {
		var err error
		*data, err = bridge.DataDirectory()
		if err != nil {
			return 1, err
		}
	}
	if args[0] == "connections" {
		ids, err := connections(*data)
		if err != nil {
			return 1, err
		}
		return 0, json.NewEncoder(output).Encode(map[string]any{"connections": ids})
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	api, err := connect(ctx, *data, *connection)
	if err != nil {
		return 1, err
	}
	if args[0] == "models" {
		result, err := api.call(ctx, "GET", "models", nil, "")
		if err != nil {
			return 1, err
		}
		return 0, json.NewEncoder(output).Encode(result)
	}
	if len(args) < 2 {
		return 1, errors.New("Choose an operation; use helios --help")
	}
	operation := args[0] + " " + args[1]
	remaining := args[2:]
	id := ""
	if args[0] == "job" {
		if len(remaining) == 0 {
			return 1, errors.New("A job ID is required")
		}
		id, remaining = remaining[0], remaining[1:]
	}
	flags := flag.NewFlagSet(operation, flag.ContinueOnError)
	flags.SetOutput(errorOutput)
	requestFile := flags.String("request", "", "JSON request file or '-' for stdin")
	referenceFile := flags.String("file", "", "User-selected reference image")
	outputFile := flags.String("output", "", "Image output path")
	index := flags.Int("index", 0, "Image output index")
	timeout := flags.Int("timeout", 120, "Wait timeout in seconds")
	force := flags.Bool("force", false, "Explicitly replace an output file")
	flags.Bool("json", true, "JSON output")
	if err := flags.Parse(remaining); err != nil {
		return 1, err
	}
	if len(flags.Args()) != 0 {
		return 1, errors.New("Unexpected argument")
	}
	var result any
	switch operation {
	case "reference import":
		if *referenceFile == "" {
			return 1, errors.New("--file is required")
		}
		file, err := os.Open(*referenceFile)
		if err != nil {
			return 1, err
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return 1, err
		}
		if !info.Mode().IsRegular() || info.Size() > 50<<20 {
			return 1, errors.New("Reference must be a regular image file of at most 50 MiB")
		}
		result, err = api.call(ctx, "POST", "references", file, "application/octet-stream")
		if err != nil {
			return 1, err
		}
	case "image submit":
		if *requestFile == "" {
			return 1, errors.New("--request is required")
		}
		reader := input
		if *requestFile != "-" {
			file, err := os.Open(*requestFile)
			if err != nil {
				return 1, err
			}
			defer file.Close()
			reader = file
		}
		buffer, err := io.ReadAll(io.LimitReader(reader, (1<<20)+1))
		if err != nil {
			return 1, err
		}
		if len(buffer) > 1<<20 {
			return 1, errors.New("Request exceeds 1 MiB")
		}
		var request map[string]any
		if err = json.Unmarshal(buffer, &request); err != nil || request == nil {
			return 1, errors.New("Request must be one JSON object")
		}
		attachSource(request, os.Getenv("REX_SESSION"), os.Getenv("REX_BLOCK"))
		buffer, err = json.Marshal(request)
		if err != nil {
			return 1, err
		}
		result, err = api.call(ctx, "POST", "jobs", bytes.NewReader(buffer), "application/json")
		if err != nil {
			return 1, err
		}
	case "job get", "job open":
		path, method := "jobs/"+url.PathEscape(id), "GET"
		if operation == "job open" {
			path += "/open"
			method = "POST"
		}
		result, err = api.call(ctx, method, path, nil, "")
		if err != nil {
			return 1, err
		}
	case "job wait":
		if *timeout < 1 || *timeout > 3600 {
			return 1, errors.New("--timeout must be 1–3600 seconds")
		}
		deadline := time.Now().Add(time.Duration(*timeout) * time.Second)
		for {
			result, err = api.call(ctx, "GET", "jobs/"+url.PathEscape(id), nil, "")
			if err != nil {
				return 1, err
			}
			status := object(result)["status"]
			if status == "done" {
				break
			}
			if status == "error" || status == "rejected" {
				_ = json.NewEncoder(output).Encode(result)
				return 1, errors.New("Generation failed or was rejected; it was not resubmitted")
			}
			if time.Now().After(deadline) {
				_ = json.NewEncoder(output).Encode(result)
				return 2, errors.New("Wait timed out; the job was not cancelled or resubmitted")
			}
			select {
			case <-ctx.Done():
				return 130, ctx.Err()
			case <-time.After(time.Second):
			}
		}
	case "job download":
		if *outputFile == "" || *index < 0 {
			return 1, errors.New("--output is required and --index must be nonnegative")
		}
		result, err = api.download(ctx, id, *outputFile, *index, *force)
		if err != nil {
			return 1, err
		}
	case "jobs watch":
		return watch(ctx, api, output)
	default:
		return 1, errors.New("Unknown operation; use helios --help")
	}
	return 0, json.NewEncoder(output).Encode(result)
}

func attachSource(request map[string]any, rexSession, rexBlock string) {
	if request["source"] == nil {
		request["source"] = map[string]any{}
	}
	source, ok := request["source"].(map[string]any)
	if !ok {
		return
	}
	if name, ok := source["name"].(string); source["name"] == nil || (ok && strings.TrimSpace(name) == "") {
		source["name"] = "agent"
		if rexSession != "" {
			source["name"] = "rex"
		}
	}
	if rexSession != "" {
		if source["rexSessionId"] == nil {
			source["rexSessionId"] = rexSession
		}
		if source["rexSessionId"] == rexSession && source["rexBlockId"] == nil {
			source["rexBlockId"] = rexBlock
		}
	}
}

func connections(data string) ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(bridge.Directory(data), "clients"))
	if os.IsNotExist(err) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, entry := range entries {
		id := strings.TrimSuffix(entry.Name(), ".json")
		if !entry.IsDir() && validConnection(id) && strings.HasSuffix(entry.Name(), ".json") {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

func validConnection(id string) bool {
	return regexp.MustCompile(`^connection-[a-f0-9-]{36}$`).MatchString(id)
}

func connect(ctx context.Context, data, id string) (*client, error) {
	var endpoint bridge.Endpoint
	if err := bridge.ReadPrivate(bridge.EndpointPath(data), &endpoint); err != nil {
		return nil, errors.New("Open Helios and enable Settings → 外部互联; no local endpoint is available")
	}
	if err := bridge.ValidateEndpoint(endpoint); err != nil {
		return nil, err
	}
	if id == "" {
		ids, err := connections(data)
		if err != nil {
			return nil, err
		}
		if len(ids) != 1 {
			return nil, errors.New("Choose a connection using --client ID; list IDs with helios connections")
		}
		id = ids[0]
	}
	if !validConnection(id) {
		return nil, errors.New("Invalid connection ID")
	}
	var credential bridge.Credential
	if err := bridge.ReadPrivate(bridge.CredentialPath(data, id), &credential); err != nil {
		return nil, err
	}
	if credential.ClientID != id || len(credential.Token) != 64 {
		return nil, errors.New("Invalid connection credential")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	api := &client{endpoint: endpoint, credential: credential, http: &http.Client{Timeout: 60 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("Integration redirects are not allowed") }}}
	response, err := api.call(ctx, "GET", "health", nil, "")
	if err != nil {
		return nil, err
	}
	if object(response)["instance"] != endpoint.Instance || object(response)["clientId"] != credential.ClientID {
		return nil, errors.New("Helios endpoint instance changed; reopen the application")
	}
	return api, nil
}

func (api *client) request(ctx context.Context, method, path string, body io.Reader, contentType string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, api.endpoint.URL+"/api/integrations/v1/"+path, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+api.credential.Token)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := api.http.Do(request)
	if err != nil {
		return nil, errors.New("Helios could not be reached; open the application and retry the same request ID")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		var failure map[string]any
		_ = json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&failure)
		return nil, fmt.Errorf("Helios HTTP %d: %v", response.StatusCode, failure["error"])
	}
	return response, nil
}

func (api *client) call(ctx context.Context, method, path string, body io.Reader, contentType string) (any, error) {
	response, err := api.request(ctx, method, path, body, contentType)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var result any
	err = json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(&result)
	return result, err
}

func object(value any) map[string]any {
	result, _ := value.(map[string]any)
	if result == nil {
		return map[string]any{}
	}
	return result
}

func (api *client) download(ctx context.Context, id, target string, index int, force bool) (any, error) {
	filename, err := filepath.Abs(target)
	if err != nil {
		return nil, err
	}
	response, err := api.request(ctx, "GET", fmt.Sprintf("jobs/%s/output?index=%d", url.PathEscape(id), index), nil, "")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if !strings.HasPrefix(response.Header.Get("Content-Type"), "image/") {
		return nil, errors.New("Output is not an image")
	}
	file, err := os.CreateTemp(filepath.Dir(filename), ".helios-image-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(file.Name())
	size, err := io.Copy(file, io.LimitReader(response.Body, (100<<20)+1))
	if err == nil && size > 100<<20 {
		err = errors.New("Image output exceeds 100 MiB")
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if force {
		err = os.Rename(file.Name(), filename)
	} else {
		err = os.Link(file.Name(), filename)
	}
	if err != nil {
		return nil, fmt.Errorf("Output was not replaced (use --force only if intended): %w", err)
	}
	return map[string]any{"jobId": id, "path": filename, "bytes": size}, nil
}

func watch(ctx context.Context, api *client, output io.Writer) (int, error) {
	terminal := false
	if file, ok := output.(*os.File); ok {
		if info, err := file.Stat(); err == nil {
			terminal = info.Mode()&os.ModeCharDevice != 0
		}
	}
	previous := ""
	for {
		result, err := api.call(ctx, "GET", "jobs", nil, "")
		if err != nil {
			return 1, err
		}
		buffer, err := json.Marshal(result)
		if err != nil {
			return 1, err
		}
		if string(buffer) != previous {
			previous = string(buffer)
			if !terminal {
				_, err = fmt.Fprintln(output, previous)
			} else {
				jobs, _ := result.([]any)
				state, kind := "idle", ""
				for _, entry := range jobs {
					status := object(entry)["status"]
					if status == "done" && state == "idle" {
						state = "done"
					}
					if status == "error" && (state == "idle" || state == "done") {
						state = "error"
					}
					if status == "pending" && state != "blocked" {
						state = "working"
					}
					if status == "awaiting_approval" {
						state, kind = "blocked", ":kind=permission"
					}
				}
				_, err = fmt.Fprintf(output, "\x1b]7501;id=helios:state=%s%s:app=helios:msg=%s\x1b\\\nHelios image jobs\n", state, kind, base64.StdEncoding.EncodeToString([]byte("Image tasks: "+state)))
				for index, entry := range jobs {
					if index >= 20 {
						break
					}
					job := object(entry)
					_, _ = fmt.Fprintf(output, "%v  %v\n", job["jobId"], job["status"])
				}
			}
			if err != nil {
				return 1, err
			}
		}
		select {
		case <-ctx.Done():
			if terminal {
				_, _ = io.WriteString(output, "\x1b]7501;id=helios:state=clear\x1b\\")
			}
			return 130, nil
		case <-time.After(2 * time.Second):
		}
	}
}

package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"heliosgen/internal/bridge"
)

type integrationClient struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	TokenHash   string `json:"tokenHash"`
	AutoApprove bool   `json:"autoApprove"`
}

type integrationSettings struct {
	Enabled bool                `json:"enabled"`
	Clients []integrationClient `json:"clients"`
}

func (backend *Server) integrationSettings() integrationSettings {
	settings := integrationSettings{Clients: []integrationClient{}}
	_ = json.Unmarshal([]byte(backend.setting("external_integrations")), &settings)
	return settings
}

func strictIntegrationBody(request *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(request.Body, (1<<20)+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return bad("Invalid integration request: " + err.Error())
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return bad("Only one JSON request is accepted")
	}
	return nil
}

func (backend *Server) publishIntegrationLocked() error {
	if !backend.integrationSettings().Enabled || backend.integrationEndpoint == "" {
		err := os.Remove(bridge.EndpointPath(backend.config.DataDir))
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return bridge.WritePrivate(bridge.EndpointPath(backend.config.DataDir), bridge.Endpoint{URL: backend.integrationEndpoint, Instance: backend.integrationInstance})
}

func (backend *Server) SetIntegrationEndpoint(endpoint string) error {
	if err := bridge.ValidateEndpoint(bridge.Endpoint{URL: endpoint, Instance: backend.integrationInstance}); err != nil {
		return err
	}
	backend.integrationMu.Lock()
	defer backend.integrationMu.Unlock()
	backend.integrationEndpoint = endpoint
	if err := backend.publishIntegrationLocked(); err != nil {
		return err
	}
	if !backend.integrationSettings().Enabled {
		return nil
	}
	rows, err := backend.rows("SELECT id FROM integration_jobs WHERE state IN ('approved','launching')")
	if err != nil {
		return err
	}
	for _, row := range rows {
		backend.launchIntegrationJob(text(row["id"]))
	}
	return nil
}

func (backend *Server) unpublishIntegration() {
	backend.integrationMu.Lock()
	defer backend.integrationMu.Unlock()
	var endpoint bridge.Endpoint
	if bridge.ReadPrivate(bridge.EndpointPath(backend.config.DataDir), &endpoint) == nil && endpoint.Instance == backend.integrationInstance {
		_ = os.Remove(bridge.EndpointPath(backend.config.DataDir))
	}
}

func (backend *Server) integrationChanged(event Object) {
	backend.integrationEventMu.Lock()
	defer backend.integrationEventMu.Unlock()
	for listener := range backend.integrationListeners {
		select {
		case listener <- event:
		default:
		}
	}
}

func (backend *Server) integrationEvents(response http.ResponseWriter, request *http.Request) {
	if err := method(request, "GET"); err != nil {
		writeError(response, err)
		return
	}
	listener := make(chan Object, 32)
	backend.integrationEventMu.Lock()
	backend.integrationListeners[listener] = struct{}{}
	backend.integrationEventMu.Unlock()
	defer func() {
		backend.integrationEventMu.Lock()
		delete(backend.integrationListeners, listener)
		backend.integrationEventMu.Unlock()
	}()
	sseHeaders(response)
	if emitSSE(response, Object{"connected": true}) != nil {
		return
	}
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case <-backend.ctx.Done():
			return
		case event := <-listener:
			if emitSSE(response, event) != nil {
				return
			}
		case <-heartbeat.C:
			if _, err := io.WriteString(response, ": keepalive\n\n"); err != nil {
				return
			}
			if flusher, ok := response.(http.Flusher); ok {
				flusher.Flush()
			}
		}
	}
}

func (backend *Server) integrationOverview() (Object, error) {
	settings := backend.integrationSettings()
	clients := []any{}
	for _, client := range settings.Clients {
		clients = append(clients, Object{"id": client.ID, "name": client.Name, "autoApprove": client.AutoApprove})
	}
	jobs, err := backend.integrationJobList("", true)
	if err != nil {
		return nil, err
	}
	models, _, err := backend.integrationModels()
	return Object{"enabled": settings.Enabled, "clients": clients, "jobs": jobs, "models": models, "endpoint": backend.integrationEndpoint, "installedAgents": backend.integrationInstalledAgents()}, err
}

func (backend *Server) integrationAdmin(response http.ResponseWriter, request *http.Request) {
	if request.Header.Get("X-Helios-UI") != "1" {
		writeError(response, &HTTPError{403, "Use the application settings to manage connections"})
		return
	}
	backend.integrationMu.Lock()
	defer backend.integrationMu.Unlock()
	if request.Method == "GET" {
		result, err := backend.integrationOverview()
		if err != nil {
			writeError(response, err)
		} else {
			writeJSON(response, 200, result)
		}
		return
	}
	if err := method(request, "POST"); err != nil {
		writeError(response, err)
		return
	}
	var fields struct {
		Action      string                 `json:"action"`
		Enabled     *bool                  `json:"enabled"`
		Name        string                 `json:"name"`
		ClientID    string                 `json:"clientId"`
		AutoApprove *bool                  `json:"autoApprove"`
		JobID       string                 `json:"jobId"`
		Agent       string                 `json:"agent"`
		Parameters  *integrationParameters `json:"parameters"`
	}
	if err := strictIntegrationBody(request, &fields); err != nil {
		writeError(response, err)
		return
	}
	settings := backend.integrationSettings()
	var err error
	result := Object{}
	switch fields.Action {
	case "dismiss", "clear-processed":
		if fields.Action == "dismiss" && fields.JobID == "" {
			err = bad("jobId is required")
			break
		}
		if fields.Action == "clear-processed" && fields.JobID != "" {
			err = bad("clear-processed does not accept jobId")
			break
		}
		result["dismissedJobIds"], err = backend.dismissIntegrationJobs(fields.JobID)
	case "enable":
		if fields.Enabled == nil {
			err = bad("enabled is required")
			break
		}
		settings.Enabled = *fields.Enabled
		err = backend.setSetting("external_integrations", jsonText(settings))
		if err == nil {
			err = backend.publishIntegrationLocked()
		}
		if err == nil && settings.Enabled {
			var rows []Object
			rows, err = backend.rows("SELECT id FROM integration_jobs WHERE state IN ('approved','launching')")
			if err == nil {
				for _, row := range rows {
					backend.launchIntegrationJob(text(row["id"]))
				}
			}
		}
	case "pair":
		name := strings.TrimSpace(fields.Name)
		if name == "" || len(name) > 100 {
			err = bad("Connection name is required and must be at most 100 bytes")
			break
		}
		if len(settings.Clients) >= 20 {
			err = bad("At most 20 external connections are supported")
			break
		}
		secret := make([]byte, 32)
		if _, err = rand.Read(secret); err != nil {
			break
		}
		token := hex.EncodeToString(secret)
		digest := sha256.Sum256([]byte(token))
		client := integrationClient{ID: "connection-" + uuid(), Name: name, TokenHash: hex.EncodeToString(digest[:])}
		if fields.AutoApprove != nil {
			client.AutoApprove = *fields.AutoApprove
		}
		err = bridge.WritePrivate(bridge.CredentialPath(backend.config.DataDir, client.ID), bridge.Credential{ClientID: client.ID, Token: token})
		if err != nil {
			break
		}
		settings.Clients = append(settings.Clients, client)
		err = backend.setSetting("external_integrations", jsonText(settings))
		if err != nil {
			_ = os.Remove(bridge.CredentialPath(backend.config.DataDir, client.ID))
			break
		}
		result["clientId"] = client.ID
	case "policy", "revoke", "install":
		index := -1
		for position, client := range settings.Clients {
			if client.ID == fields.ClientID {
				index = position
				break
			}
		}
		if index < 0 {
			err = &HTTPError{404, "Connection not found"}
			break
		}
		if fields.Action == "install" {
			result, err = backend.installIntegrationTools(fields.Agent)
			if err == nil {
				result["installedAgents"] = backend.integrationInstalledAgents()
			}
			break
		}
		if fields.Action == "policy" {
			if fields.AutoApprove == nil {
				err = bad("autoApprove is required")
				break
			}
			settings.Clients[index].AutoApprove = *fields.AutoApprove
		} else {
			settings.Clients = append(settings.Clients[:index], settings.Clients[index+1:]...)
		}
		err = backend.setSetting("external_integrations", jsonText(settings))
		if err == nil && fields.Action == "revoke" {
			_ = os.Remove(bridge.CredentialPath(backend.config.DataDir, fields.ClientID))
			_, err = backend.db.Exec("UPDATE integration_jobs SET state='rejected', error='Connection revoked', updated_at=? WHERE client_id=? AND state='awaiting_approval'", now(), fields.ClientID)
		}
	case "approve", "reject", "open", "inspect":
		rows, failure := backend.rows("SELECT * FROM integration_jobs WHERE id=?", fields.JobID)
		if failure != nil {
			err = failure
			break
		}
		if len(rows) != 1 {
			err = &HTTPError{404, "Job not found"}
			break
		}
		row := rows[0]
		if fields.Action == "inspect" {
			result["job"], err = backend.integrationJob(row)
			break
		}
		if fields.Action == "open" {
			err = backend.openIntegrationJob(row)
			break
		}
		if row["state"] != "awaiting_approval" {
			err = &HTTPError{409, "This task is no longer awaiting approval"}
			break
		}
		if fields.Action == "reject" {
			_, err = backend.db.Exec("UPDATE integration_jobs SET state='rejected',error='Rejected in Helios',updated_at=? WHERE id=?", now(), fields.JobID)
			break
		}
		if !settings.Enabled {
			err = &HTTPError{403, "External connections are disabled"}
			break
		}
		found := false
		for _, client := range settings.Clients {
			if client.ID == row["client_id"] {
				found = true
			}
		}
		if !found {
			err = &HTTPError{403, "Connection revoked"}
			break
		}
		err = backend.approveIntegrationJob(row, fields.Parameters)
		if err == nil {
			backend.launchIntegrationJob(fields.JobID)
		}
	default:
		err = bad("Unknown integration action")
	}
	if err != nil {
		writeError(response, err)
		return
	}
	backend.integrationChanged(Object{"changed": true})
	if _, exists := result["installed"]; !exists {
		overview, failure := backend.integrationOverview()
		if failure != nil {
			writeError(response, failure)
			return
		}
		for key, value := range overview {
			result[key] = value
		}
	}
	writeJSON(response, 200, result)
}

func (backend *Server) authenticateIntegration(request *http.Request) (integrationClient, error) {
	settings := backend.integrationSettings()
	if !settings.Enabled {
		return integrationClient{}, &HTTPError{403, "External connections are disabled"}
	}
	if !strings.HasPrefix(request.Header.Get("Authorization"), "Bearer ") {
		return integrationClient{}, &HTTPError{401, "Bearer authentication is required"}
	}
	token := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
	if len(token) != 64 {
		return integrationClient{}, &HTTPError{401, "Invalid integration credential"}
	}
	digest := sha256.Sum256([]byte(token))
	encoded := hex.EncodeToString(digest[:])
	for _, client := range settings.Clients {
		if subtle.ConstantTimeCompare([]byte(encoded), []byte(client.TokenHash)) == 1 {
			return client, nil
		}
	}
	return integrationClient{}, &HTTPError{401, "Connection revoked or invalid credential"}
}

func integrationFailure(err error) error {
	var failure *HTTPError
	if errors.As(err, &failure) {
		return failure
	}
	return bad(err.Error())
}

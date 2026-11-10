package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

type integrationSource struct {
	Name         string `json:"name,omitempty"`
	RexSessionID string `json:"rexSessionId,omitempty"`
	RexBlockID   string `json:"rexBlockId,omitempty"`
}

type integrationRequest struct {
	RequestID    string            `json:"requestId"`
	Prompt       string            `json:"prompt"`
	ModelID      string            `json:"modelId,omitempty"`
	AspectRatio  string            `json:"aspectRatio,omitempty"`
	Quality      string            `json:"quality,omitempty"`
	ReferenceIDs []string          `json:"referenceIds,omitempty"`
	Source       integrationSource `json:"source,omitempty"`
}

func (backend *Server) integrationModels() ([]any, string, error) {
	registry, err := backend.registry()
	if err != nil {
		return nil, "", err
	}
	defaultConfig := object(defaultSavedProvider(registry, "image")["config"])
	models := []any{}
	defaultID := ""
	for _, entry := range array(registry["providers"]) {
		config := object(object(entry)["config"])
		if text(config["baseUrl"]) == "" {
			continue
		}
		for _, entry := range array(config["models"]) {
			model := object(entry)
			if model["kind"] != "image" || !truth(model["enabled"]) {
				continue
			}
			id := "provider-model:" + text(config["id"]) + ":" + text(model["id"])
			if defaultID == "" && config["id"] == defaultConfig["id"] {
				defaultID = id
			}
			if config["id"] == defaultConfig["id"] && model["apiId"] == defaultConfig["imageModel"] {
				defaultID = id
			}
			models = append(models, Object{"id": id, "name": model["name"], "providerName": config["name"], "ratios": model["ratios"], "qualityOptions": model["qualityOptions"], "maxImages": model["maxImages"], "promptMaxLength": model["promptMaxLength"]})
		}
	}
	if defaultID == "" && len(models) > 0 {
		defaultID = text(object(models[0])["id"])
	}
	return models, defaultID, nil
}

func (backend *Server) prepareIntegrationRequest(clientID string, request integrationRequest) (Object, error) {
	if !regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`).MatchString(request.RequestID) {
		return nil, bad("requestId must contain 1–128 letters, digits, dots, colons, underscores or hyphens")
	}
	if strings.TrimSpace(request.Prompt) == "" || len(request.Prompt) > 256<<10 {
		return nil, bad("A nonempty prompt of at most 256 KiB is required")
	}
	if len(request.Source.Name) > 100 || len(request.Source.RexBlockID) > 200 || len(request.Source.RexSessionID) > 200 {
		return nil, bad("Source context is too long")
	}
	models, defaultID, err := backend.integrationModels()
	if err != nil {
		return nil, err
	}
	selected := request.ModelID
	if selected == "" || selected == "default" {
		selected = defaultID
	}
	var definition Object
	for _, entry := range models {
		if object(entry)["id"] == selected {
			definition = object(entry)
			break
		}
	}
	if definition == nil {
		return nil, bad("Choose an enabled configured image model from helios models")
	}
	if request.AspectRatio != "" && !contains(array(definition["ratios"]), request.AspectRatio) {
		return nil, bad("The model does not support the requested aspectRatio")
	}
	if request.Quality != "" && !contains(array(definition["qualityOptions"]), request.Quality) {
		return nil, bad("The model does not support the requested quality")
	}
	if len(utf16.Encode([]rune(request.Prompt))) > int(number(definition["promptMaxLength"])) {
		return nil, bad("Prompt exceeds the model's supported length")
	}
	if len(request.ReferenceIDs) > 14 || len(request.ReferenceIDs) > int(number(definition["maxImages"])) {
		return nil, bad("Too many reference images for this model")
	}
	references := []any{}
	for _, id := range request.ReferenceIDs {
		var location string
		if backend.db.QueryRow("SELECT url FROM integration_assets WHERE id=? AND client_id=?", id, clientID).Scan(&location) != nil {
			return nil, bad("Reference asset does not belong to this connection")
		}
		references = append(references, location)
	}
	config, err := backend.configured(selected, "image")
	if err != nil {
		return nil, integrationFailure(err)
	}
	input := Object{"model": selected, "prompt": request.Prompt, "imageUrls": references}
	if request.AspectRatio != "" {
		input["aspectRatio"] = request.AspectRatio
	}
	if request.Quality != "" {
		input["quality"] = request.Quality
	}
	prepared, err := prepareInput(config, "image", input)
	if err != nil {
		return nil, integrationFailure(err)
	}
	return prepared, nil
}

func (backend *Server) submitIntegrationJob(client integrationClient, request integrationRequest) (Object, error) {
	original := jsonText(request)
	identity := request
	identity.Source = integrationSource{}
	digest := sha256.Sum256([]byte(jsonText(identity)))
	fingerprint := hex.EncodeToString(digest[:])
	rows, err := backend.rows("SELECT * FROM integration_jobs WHERE client_id=? AND request_id=?", client.ID, request.RequestID)
	if err != nil {
		return nil, err
	}
	if len(rows) > 0 {
		if rows[0]["fingerprint"] != fingerprint {
			return nil, &HTTPError{409, "requestId was already used with different inputs; no new generation was submitted"}
		}
		return backend.integrationJob(rows[0])
	}
	prepared, err := backend.prepareIntegrationRequest(client.ID, request)
	if err != nil {
		return nil, err
	}
	request.ModelID = text(prepared["model"])
	request.AspectRatio = text(prepared["aspectRatio"])
	request.Quality = text(prepared["quality"])
	jobs, err := backend.integrationJobs(client.ID)
	if err != nil {
		return nil, err
	}
	active := 0
	for _, entry := range jobs {
		if contains([]any{"awaiting_approval", "approved", "launching", "pending"}, object(entry)["status"]) {
			active++
		}
	}
	if active >= 4 {
		return nil, &HTTPError{429, "At most four unfinished image requests per connection are allowed"}
	}
	var recent int
	if err = backend.db.QueryRow("SELECT COUNT(*) FROM integration_jobs WHERE client_id=? AND created_at>?", client.ID, time.Now().Add(-10*time.Minute).UTC().Format("2006-01-02T15:04:05.000Z")).Scan(&recent); err != nil {
		return nil, err
	}
	if recent >= 40 {
		return nil, &HTTPError{429, "Image request rate limit reached; try again later"}
	}
	id := "external-" + uuid()
	state := "awaiting_approval"
	if client.AutoApprove {
		state = "approved"
	}
	transaction, err := backend.db.Begin()
	if err != nil {
		return nil, err
	}
	defer transaction.Rollback()
	_, err = transaction.Exec("INSERT INTO integration_jobs(id,client_id,request_id,fingerprint,request,state,task_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)", id, client.ID, request.RequestID, fingerprint, jsonText(request), state, "custom-"+id, now(), now())
	if err == nil {
		var approvedAt any
		if state == "approved" {
			approvedAt = now()
		}
		_, err = transaction.Exec("INSERT INTO integration_job_reviews(job_id,original_request,approved_at) VALUES(?,?,?)", id, original, approvedAt)
	}
	if err == nil {
		err = transaction.Commit()
	}
	if err != nil {
		return nil, err
	}
	if state == "approved" {
		backend.launchIntegrationJob(id)
	}
	backend.integrationChanged(Object{"changed": true})
	rows, err = backend.rows("SELECT * FROM integration_jobs WHERE id=?", id)
	if err != nil {
		return nil, err
	}
	return backend.integrationJob(rows[0])
}

func (backend *Server) launchIntegrationJob(id string) {
	rows, err := backend.rows("SELECT * FROM integration_jobs WHERE id=?", id)
	if err != nil || len(rows) != 1 {
		return
	}
	row := rows[0]
	if row["state"] != "approved" && row["state"] != "launching" {
		return
	}
	var existing string
	if backend.db.QueryRow("SELECT task_id FROM generations WHERE task_id=?", row["task_id"]).Scan(&existing) == nil {
		_, _ = backend.db.Exec("UPDATE integration_jobs SET state='running',updated_at=? WHERE id=?", now(), id)
		return
	}
	settings := backend.integrationSettings()
	authorized := false
	for _, client := range settings.Clients {
		if client.ID == row["client_id"] {
			authorized = true
		}
	}
	if !authorized {
		_, _ = backend.db.Exec("UPDATE integration_jobs SET state='rejected',error='Connection revoked',updated_at=? WHERE id=?", now(), id)
		return
	}
	if !settings.Enabled {
		return
	}
	var request integrationRequest
	err = json.Unmarshal([]byte(text(row["request"])), &request)
	var fields Object
	if err == nil {
		fields, err = backend.prepareIntegrationRequest(text(row["client_id"]), request)
	}
	if err == nil {
		_, err = backend.db.Exec("UPDATE integration_jobs SET state='launching',updated_at=? WHERE id=?", now(), id)
	}
	if err == nil {
		ctx := context.WithValue(backend.ctx, integrationTaskKey{}, text(row["task_id"]))
		_, err = backend.generateImage(ctx, fields)
	}
	if err != nil {
		_, _ = backend.db.Exec("UPDATE integration_jobs SET state='error',error=?,updated_at=? WHERE id=?", err.Error(), now(), id)
	} else {
		_, _ = backend.db.Exec("UPDATE integration_jobs SET state='running',updated_at=? WHERE id=?", now(), id)
	}
	backend.integrationChanged(Object{"changed": true})
}

func (backend *Server) integrationJob(row Object) (Object, error) {
	var request integrationRequest
	if err := json.Unmarshal([]byte(text(row["request"])), &request); err != nil {
		return nil, err
	}
	status := text(row["state"])
	result := Object{"jobId": row["id"], "clientId": row["client_id"], "requestId": row["request_id"], "status": status, "prompt": request.Prompt, "modelId": request.ModelID, "source": request.Source, "createdAt": row["created_at"], "aspectRatio": request.AspectRatio, "quality": request.Quality}
	result["referenceIds"] = request.ReferenceIDs
	var dismissed bool
	if err := backend.db.QueryRow("SELECT EXISTS(SELECT 1 FROM integration_inbox_dismissals WHERE job_id=?)", row["id"]).Scan(&dismissed); err != nil {
		return nil, err
	}
	result["inboxDismissed"] = dismissed
	var original string
	var edited int
	var approvedAt any
	if err := backend.db.QueryRow("SELECT original_request,edited,approved_at FROM integration_job_reviews WHERE job_id=?", row["id"]).Scan(&original, &edited, &approvedAt); err == nil {
		var originalRequest integrationRequest
		if err = json.Unmarshal([]byte(original), &originalRequest); err != nil {
			return nil, err
		}
		result["originalRequest"] = originalRequest
		result["configurationEdited"] = edited != 0
		result["approvedAt"] = approvedAt
	} else if err == sql.ErrNoRows {
		result["originalRequest"] = request
		result["configurationEdited"] = false
	} else {
		return nil, err
	}
	references := []any{}
	for _, id := range request.ReferenceIDs {
		var location string
		if backend.db.QueryRow("SELECT url FROM integration_assets WHERE id=? AND client_id=?", id, row["client_id"]).Scan(&location) == nil {
			references = append(references, location)
		}
	}
	result["referenceUrls"] = references
	if truth(row["error"]) {
		result["error"] = row["error"]
	}
	if status == "running" || status == "done" {
		job := backend.getJob(text(row["task_id"]))
		if len(job) == 0 {
			job = backend.recoverJob(text(row["task_id"]))
		}
		if job["status"] == "pending" {
			if len(backend.getJob(text(row["task_id"]))) > 0 {
				backend.resumeJob(text(row["task_id"]), job)
			} else {
				job = Object{"status": "error", "error": "The application restarted during generation; no automatic paid retry was made"}
			}
		}
		if job["status"] == "not_found" {
			job = Object{"status": "error", "error": "Generation task could not be recovered"}
		}
		result["status"] = job["status"]
		if job["error"] != nil {
			result["error"] = job["error"]
		}
		if job["status"] == "done" || job["status"] == "error" {
			_, err := backend.db.Exec("UPDATE integration_jobs SET state=?,error=?,updated_at=? WHERE id=?", job["status"], job["error"], now(), row["id"])
			if err != nil {
				return nil, err
			}
		}
		outputs := []any{}
		locations := array(job["imageUrls"])
		if len(locations) == 0 && truth(job["imageUrl"]) {
			locations = []any{job["imageUrl"]}
		}
		for index, location := range locations {
			assetID := fmt.Sprintf("%s-output-%d", row["id"], index)
			_, err := backend.db.Exec("INSERT OR IGNORE INTO integration_assets(id,client_id,url,mime_type,created_at) VALUES(?,?,?,?,?)", assetID, row["client_id"], location, "image/"+strings.TrimPrefix(filepath.Ext(text(location)), "."), now())
			if err != nil {
				return nil, err
			}
			outputs = append(outputs, Object{"assetId": assetID, "url": location, "index": index})
		}
		result["outputs"] = outputs
	}
	return result, nil
}

func (backend *Server) integrationJobs(clientID string) ([]any, error) {
	return backend.integrationJobList(clientID, false)
}

func (backend *Server) integrationJobList(clientID string, inbox bool) ([]any, error) {
	query := "SELECT * FROM integration_jobs"
	args := []any{}
	if clientID != "" {
		query += " WHERE client_id=?"
		args = append(args, clientID)
	}
	if inbox {
		if clientID == "" {
			query += " WHERE"
		} else {
			query += " AND"
		}
		query += " NOT EXISTS (SELECT 1 FROM integration_inbox_dismissals WHERE job_id=integration_jobs.id)"
	}
	query += " ORDER BY (state IN ('awaiting_approval','approved','launching','running')) DESC, created_at DESC LIMIT 100"
	rows, err := backend.rows(query, args...)
	if err != nil {
		return nil, err
	}
	jobs := []any{}
	for _, row := range rows {
		job, err := backend.integrationJob(row)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, nil
}

func (backend *Server) openIntegrationJob(row Object) error {
	job, err := backend.integrationJob(row)
	if err != nil {
		return err
	}
	if job["status"] != "done" {
		return &HTTPError{409, "The image is not ready to open"}
	}
	backend.integrationChanged(Object{"openJob": row["id"]})
	if backend.config.Focus != nil {
		backend.config.Focus()
	}
	return nil
}

func (backend *Server) integrationAPI(response http.ResponseWriter, request *http.Request) {
	backend.integrationMu.Lock()
	locked := true
	defer func() {
		if locked {
			backend.integrationMu.Unlock()
		}
	}()
	client, err := backend.authenticateIntegration(request)
	if err != nil {
		writeError(response, err)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	path := strings.TrimPrefix(request.URL.Path, "/api/integrations/v1/")
	var result any
	switch {
	case path == "health":
		err = method(request, "GET")
		result = Object{"instance": backend.integrationInstance, "clientId": client.ID, "version": backend.config.Version}
	case path == "models":
		if err = method(request, "GET"); err != nil {
			break
		}
		var models []any
		var defaultID string
		models, defaultID, err = backend.integrationModels()
		result = Object{"models": models, "defaultModelId": defaultID}
	case path == "references":
		if err = method(request, "POST"); err != nil {
			break
		}
		backend.integrationMu.Unlock()
		locked = false
		buffer, failure := io.ReadAll(io.LimitReader(request.Body, (50<<20)+1))
		if failure != nil {
			writeError(response, failure)
			return
		}
		if len(buffer) > 50<<20 {
			writeError(response, &HTTPError{413, "Reference exceeds 50 MiB"})
			return
		}
		contentType := http.DetectContentType(buffer)
		if !strings.HasPrefix(contentType, "image/") {
			writeError(response, bad("Import a PNG, JPEG, GIF or WebP image"))
			return
		}
		backend.integrationMu.Lock()
		locked = true
		if client, err = backend.authenticateIntegration(request); err != nil {
			break
		}
		var location string
		location, err = backend.uploadBuffer(buffer, contentType, "references")
		if err != nil {
			break
		}
		id := "asset-" + uuid()
		_, err = backend.db.Exec("INSERT INTO integration_assets(id,client_id,url,mime_type,created_at) VALUES(?,?,?,?,?)", id, client.ID, location, contentType, now())
		result = Object{"assetId": id, "url": location}
	case path == "jobs" && request.Method == "GET":
		result, err = backend.integrationJobs(client.ID)
	case path == "jobs":
		if err = method(request, "POST"); err != nil {
			break
		}
		var fields integrationRequest
		if err = strictIntegrationBody(request, &fields); err == nil {
			result, err = backend.submitIntegrationJob(client, fields)
		}
	case strings.HasPrefix(path, "jobs/"):
		parts := strings.Split(path, "/")
		if len(parts) < 2 || len(parts) > 3 {
			err = &HTTPError{404, "Unknown job operation"}
			break
		}
		rows, failure := backend.rows("SELECT * FROM integration_jobs WHERE id=? AND client_id=?", parts[1], client.ID)
		if failure != nil {
			err = failure
			break
		}
		if len(rows) != 1 {
			err = &HTTPError{404, "Job not found for this connection"}
			break
		}
		if len(parts) == 2 {
			if err = method(request, "GET"); err == nil {
				result, err = backend.integrationJob(rows[0])
			}
		} else if parts[2] == "open" {
			if err = method(request, "POST"); err == nil {
				err = backend.openIntegrationJob(rows[0])
				result = Object{"ok": true}
			}
		} else if parts[2] == "output" {
			if err = method(request, "GET"); err != nil {
				break
			}
			var job Object
			job, err = backend.integrationJob(rows[0])
			if err != nil {
				break
			}
			index := 0
			if requested := request.URL.Query().Get("index"); requested != "" {
				index, err = strconv.Atoi(requested)
				if err != nil {
					err = bad("index must be a nonnegative integer")
					break
				}
			}
			outputs := array(job["outputs"])
			if job["status"] != "done" || index < 0 || index >= len(outputs) {
				err = &HTTPError{404, "Image output not found"}
				break
			}
			location := text(object(outputs[index])["url"])
			if !strings.HasPrefix(location, "/generated/") {
				err = bad("Only local generated images may be downloaded")
				break
			}
			backend.integrationMu.Unlock()
			locked = false
			copy := request.Clone(request.Context())
			copy.URL = &url.URL{Path: location}
			backend.serveMedia(response, copy)
			return
		} else {
			err = &HTTPError{404, "Unknown job operation"}
		}
	default:
		err = &HTTPError{404, "Integration operation not found"}
	}
	if err != nil {
		writeError(response, err)
	} else {
		writeJSON(response, 200, result)
	}
}

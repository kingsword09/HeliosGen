package server

import (
	"encoding/json"
	"io"
	"net/http"
)

type integrationParameters struct {
	Prompt       string   `json:"prompt"`
	ModelID      string   `json:"modelId"`
	AspectRatio  string   `json:"aspectRatio"`
	Quality      string   `json:"quality"`
	ReferenceIDs []string `json:"referenceIds"`
}

func (backend *Server) approveIntegrationJob(row Object, parameters *integrationParameters) error {
	var request integrationRequest
	if err := json.Unmarshal([]byte(text(row["request"])), &request); err != nil {
		return err
	}
	if request.ReferenceIDs == nil {
		request.ReferenceIDs = []string{}
	}
	previous := jsonText(request)
	if parameters != nil {
		request.Prompt = parameters.Prompt
		request.ModelID = parameters.ModelID
		request.AspectRatio = parameters.AspectRatio
		request.Quality = parameters.Quality
		request.ReferenceIDs = parameters.ReferenceIDs
	}
	if request.ReferenceIDs == nil {
		request.ReferenceIDs = []string{}
	}
	prepared, err := backend.prepareIntegrationRequest(text(row["client_id"]), request)
	if err != nil {
		return err
	}
	request.ModelID = text(prepared["model"])
	request.AspectRatio = text(prepared["aspectRatio"])
	request.Quality = text(prepared["quality"])
	updated := jsonText(request)
	edited := updated != previous
	transaction, err := backend.db.Begin()
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	result, err := transaction.Exec("UPDATE integration_jobs SET state='approved',request=?,updated_at=? WHERE id=? AND state='awaiting_approval'", updated, now(), row["id"])
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return err
	} else if affected != 1 {
		return &HTTPError{409, "This task is no longer awaiting approval"}
	}
	_, err = transaction.Exec("INSERT INTO integration_job_reviews(job_id,original_request,edited,approved_at) VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET edited=excluded.edited,approved_at=excluded.approved_at", row["id"], row["request"], edited, now())
	if err != nil {
		return err
	}
	return transaction.Commit()
}

func (backend *Server) integrationAdminReference(response http.ResponseWriter, request *http.Request) {
	if request.Header.Get("X-Helios-UI") != "1" {
		writeError(response, &HTTPError{403, "Use the application to import a reference"})
		return
	}
	if err := method(request, "POST"); err != nil {
		writeError(response, err)
		return
	}
	buffer, err := io.ReadAll(io.LimitReader(request.Body, (50<<20)+1))
	if err != nil {
		writeError(response, err)
		return
	}
	if len(buffer) > 50<<20 {
		writeError(response, &HTTPError{413, "Reference exceeds 50 MiB"})
		return
	}
	contentType := http.DetectContentType(buffer)
	if !contains([]any{"image/png", "image/jpeg", "image/gif", "image/webp"}, contentType) {
		writeError(response, bad("Import a PNG, JPEG, GIF or WebP image"))
		return
	}
	backend.integrationMu.Lock()
	defer backend.integrationMu.Unlock()
	settings := backend.integrationSettings()
	if !settings.Enabled {
		writeError(response, &HTTPError{403, "External connections are disabled"})
		return
	}
	rows, err := backend.rows("SELECT * FROM integration_jobs WHERE id=?", request.URL.Query().Get("jobId"))
	if err != nil || len(rows) != 1 {
		if err == nil {
			err = &HTTPError{404, "Job not found"}
		}
		writeError(response, err)
		return
	}
	row := rows[0]
	if row["state"] != "awaiting_approval" {
		writeError(response, &HTTPError{409, "References may only be edited before approval"})
		return
	}
	authorized := false
	for _, client := range settings.Clients {
		if client.ID == row["client_id"] {
			authorized = true
		}
	}
	if !authorized {
		writeError(response, &HTTPError{403, "Connection revoked"})
		return
	}
	location, err := backend.uploadBuffer(buffer, contentType, "references")
	if err != nil {
		writeError(response, err)
		return
	}
	id := "asset-" + uuid()
	_, err = backend.db.Exec("INSERT INTO integration_assets(id,client_id,url,mime_type,created_at) VALUES(?,?,?,?,?)", id, row["client_id"], location, contentType, now())
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, 200, Object{"assetId": id, "url": location})
}

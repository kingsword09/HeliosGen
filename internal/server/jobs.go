package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (backend *Server) jobs() Object {
	encoded, err := os.ReadFile(filepath.Join(backend.config.DataDir, ".job-store.json"))
	if err != nil {
		return Object{}
	}
	var jobs Object
	if json.Unmarshal(encoded, &jobs) != nil || jobs == nil {
		return Object{}
	}
	return jobs
}

func (backend *Server) getJob(id string) Object {
	backend.jobMu.Lock()
	defer backend.jobMu.Unlock()
	return object(backend.jobs()[id])
}

func (backend *Server) setJob(id string, result Object) error {
	backend.jobMu.Lock()
	defer backend.jobMu.Unlock()
	jobs := backend.jobs()
	jobs[id] = result
	filename := filepath.Join(backend.config.DataDir, ".job-store.json")
	if err := os.WriteFile(filename+".tmp", []byte(jsonText(jobs)), 0600); err != nil {
		return err
	}
	if err := os.Rename(filename+".tmp", filename); err != nil {
		return err
	}
	for listener := range backend.events {
		select {
		case listener <- Object{"id": id, "result": result}:
		default:
		}
	}
	if strings.HasPrefix(id, "custom-external-") {
		backend.integrationChanged(Object{"jobChanged": true})
	}
	return nil
}

func (backend *Server) settle(id string, result Object) {
	if result["status"] == "done" {
		_ = backend.updateGeneration(id, Object{"status": "done", "image_url": result["imageUrl"], "image_urls": result["imageUrls"], "video_url": result["videoUrl"]})
	} else if result["status"] == "error" {
		_ = backend.updateGeneration(id, Object{"status": "error", "error_msg": result["error"]})
	}
	_ = backend.setJob(id, result)
}

func (backend *Server) complete(id, kind string, urls []any) {
	if len(urls) == 0 {
		backend.settle(id, Object{"status": "error", "error": "Provider returned no output."})
		return
	}
	result := Object{"status": "done"}
	if kind == "video" {
		result["videoUrl"] = urls[0]
	} else {
		result["imageUrl"] = urls[0]
		result["imageUrls"] = urls
	}
	backend.settle(id, result)
}

func (backend *Server) claimJob(id string) bool {
	backend.jobMu.Lock()
	defer backend.jobMu.Unlock()
	if backend.running[id] || backend.ctx.Err() != nil {
		return false
	}
	backend.running[id] = true
	backend.workers.Add(1)
	return true
}
func (backend *Server) releaseJob(id string) {
	backend.jobMu.Lock()
	delete(backend.running, id)
	backend.jobMu.Unlock()
	backend.workers.Done()
}

func (backend *Server) startProviderJob(kind string, config, input, metadata Object) (string, error) {
	id := text(metadata["task_id"])
	if id == "" {
		id = "custom-" + uuid()
	}
	if strings.HasPrefix(id, "custom-external-") {
		var existing string
		if backend.db.QueryRow("SELECT task_id FROM generations WHERE task_id=?", id).Scan(&existing) == nil {
			return existing, nil
		}
	}
	metadata = clone(metadata)
	metadata["task_id"] = id
	metadata["status"] = "pending"
	metadata["generation_type"] = kind
	if err := backend.insertGeneration(metadata); err != nil {
		return "", err
	}
	if err := backend.setJob(id, Object{"status": "pending", "type": kind}); err != nil {
		return "", err
	}
	if !backend.claimJob(id) {
		return "", errors.New("Server is shutting down")
	}
	go func() {
		defer backend.releaseJob(id)
		output, err := backend.providerGeneration(backend.ctx, config, kind, input)
		if backend.ctx.Err() != nil {
			return
		}
		if err != nil {
			backend.settle(id, Object{"status": "error", "error": err.Error()})
			return
		}
		if task := object(output["task"]); len(task) > 0 {
			if err = backend.setJob(id, Object{"status": "pending", "type": kind, "providerTask": task}); err == nil {
				backend.pollJob(id, kind, task)
			}
		} else {
			backend.complete(id, kind, array(output["urls"]))
		}
	}()
	return id, nil
}

func (backend *Server) pollJob(id, kind string, task Object) {
	config := object(task["config"])
	ctx, cancel := context.WithTimeout(backend.ctx, time.Duration(number(config["timeoutSeconds"])*float64(time.Second)))
	defer cancel()
	for ctx.Err() == nil {
		current, err := backend.providerConfig(text(config["id"]), "")
		if err == nil && current["baseUrl"] != config["baseUrl"] {
			err = errors.New("This provider was removed or changed while the task was running. Restore it to resume the task.")
		}
		var value any
		if err == nil {
			value, err = backend.requestJSON(ctx, config, text(config["statusPath"]), "openai", "", text(task["id"]), nil)
		}
		if err != nil {
			if backend.ctx.Err() == nil {
				backend.settle(id, Object{"status": "error", "error": err.Error()})
			}
			return
		}
		state := strings.ToLower(text(jsonPath(value, text(config["taskStatePath"]))))
		if contains([]any{"failed", "fail", "error", "cancelled", "canceled"}, state) {
			backend.settle(id, Object{"status": "error", "error": fallback(object(value)["message"], fallback(object(value)["error"], "Provider generation failed."))})
			return
		}
		if contains([]any{"success", "succeeded", "completed", "done"}, state) {
			urls, err := backend.saveOutput(ctx, config, jsonPath(value, text(config["taskOutputPath"])), kind)
			if err != nil {
				backend.settle(id, Object{"status": "error", "error": err.Error()})
			} else if len(urls) == 0 {
				backend.settle(id, Object{"status": "error", "error": "Task completed without output. Check taskOutputPath in provider settings."})
			} else {
				backend.complete(id, kind, urls)
			}
			return
		}
		select {
		case <-ctx.Done():
		case <-time.After(3 * time.Second):
		}
	}
	if backend.ctx.Err() == nil {
		backend.settle(id, Object{"status": "error", "error": "Provider generation timed out."})
	}
}

func (backend *Server) resumeJob(id string, job Object) {
	if !strings.HasPrefix(id, "custom-") || job["status"] != "pending" || !backend.claimJob(id) {
		return
	}
	go func() {
		defer backend.releaseJob(id)
		task := object(job["providerTask"])
		if len(task) == 0 {
			backend.settle(id, Object{"status": "error", "error": "The server restarted during a synchronous request. Please generate again."})
			return
		}
		kind := text(job["type"])
		if kind != "video" {
			kind = "image"
		}
		backend.pollJob(id, kind, task)
	}()
}

func (backend *Server) recoverJob(id string) Object {
	rows, err := backend.rows("SELECT * FROM generations WHERE task_id=? ORDER BY created_at DESC LIMIT 1", id)
	if err != nil || len(rows) == 0 {
		return Object{"status": "not_found"}
	}
	row := generation(object(rows[0]))
	if row["status"] == "error" {
		return Object{"status": "error", "error": fallback(row["error_msg"], "Generation failed")}
	}
	if row["status"] == "done" {
		result := Object{"status": "done"}
		if truth(row["video_url"]) {
			result["videoUrl"] = row["video_url"]
		} else {
			if row["image_url"] != nil {
				result["imageUrl"] = row["image_url"]
			}
			if row["image_urls"] != nil {
				result["imageUrls"] = row["image_urls"]
			}
		}
		return result
	}
	return Object{"status": "pending"}
}

func (backend *Server) jobStatus(request *http.Request) (any, error) {
	if err := method(request, "GET"); err != nil {
		return nil, err
	}
	id := request.URL.Query().Get("taskId")
	if id == "" {
		return nil, bad("taskId is required")
	}
	job := backend.getJob(id)
	if len(job) > 0 {
		backend.resumeJob(id, job)
		return job, nil
	}
	if strings.HasPrefix(id, "azure-") {
		return Object{"status": "not_found"}, nil
	}
	job = backend.recoverJob(id)
	if job["status"] == "done" || job["status"] == "error" {
		_ = backend.setJob(id, job)
	}
	return job, nil
}

func (backend *Server) jobStream(response http.ResponseWriter, request *http.Request) {
	if err := method(request, "GET"); err != nil {
		writeError(response, err)
		return
	}
	id := request.URL.Query().Get("taskId")
	if id == "" {
		http.Error(response, "taskId required", 400)
		return
	}
	listener := make(chan Object, 128)
	backend.jobMu.Lock()
	backend.events[listener] = struct{}{}
	backend.jobMu.Unlock()
	defer func() { backend.jobMu.Lock(); delete(backend.events, listener); backend.jobMu.Unlock() }()
	job := backend.getJob(id)
	if len(job) == 0 {
		job = backend.recoverJob(id)
		if job["status"] != "done" && job["status"] != "error" {
			job = Object{"status": "error", "error": "Job not found"}
		}
	}
	sseHeaders(response)
	if job["status"] != "pending" {
		_ = emitSSE(response, job)
		return
	}
	backend.resumeJob(id, job)
	if flusher, ok := response.(http.Flusher); ok {
		flusher.Flush()
	}
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	deadline := time.NewTimer(12 * time.Minute)
	defer deadline.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case <-backend.ctx.Done():
			return
		case event := <-listener:
			if event["id"] == id && object(event["result"])["status"] != "pending" {
				_ = emitSSE(response, event["result"])
				return
			}
		case <-heartbeat.C:
			if _, err := fmt.Fprint(response, ": ping\n\n"); err != nil {
				return
			}
			if flusher, ok := response.(http.Flusher); ok {
				flusher.Flush()
			}
			current := backend.getJob(id)
			if current["status"] != "pending" {
				_ = emitSSE(response, current)
				return
			}
		case <-deadline.C:
			_ = emitSSE(response, Object{"status": "error", "error": "Generation timed out"})
			return
		}
	}
}

package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

func (backend *Server) workflows(request *http.Request) (any, error) {
	if request.Method == "GET" {
		rows, err := backend.rows("SELECT data FROM spaces ORDER BY updated_at ASC")
		if err != nil {
			return nil, err
		}
		spaces := []any{}
		for _, row := range rows {
			var value any
			if json.Unmarshal([]byte(text(row["data"])), &value) == nil {
				spaces = append(spaces, value)
			}
		}
		return Object{"spaces": spaces}, nil
	}
	if err := method(request, "PUT"); err != nil {
		return nil, err
	}
	fields, err := body(request)
	if err != nil {
		return nil, err
	}
	spaces, valid := fields["spaces"].([]any)
	if !valid {
		return nil, bad("spaces[] required")
	}
	transaction, err := backend.db.Begin()
	if err != nil {
		return nil, err
	}
	defer transaction.Rollback()
	if _, err = transaction.Exec("DELETE FROM spaces"); err != nil {
		return nil, err
	}
	for _, entry := range spaces {
		value := object(entry)
		_, err = transaction.Exec("INSERT INTO spaces (id,name,data,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,updated_at=excluded.updated_at", value["id"], fallback(value["name"], "Untitled"), jsonText(value), fallback(value["updatedAt"], fallback(value["createdAt"], time.Now().UnixMilli())))
		if err != nil {
			return nil, err
		}
	}
	return Object{"ok": true}, transaction.Commit()
}

func (backend *Server) folders(request *http.Request) (any, error) {
	if request.Method == "GET" {
		folders, err := backend.rows("SELECT * FROM folders WHERE user_id=? ORDER BY order_index", "guest")
		if err != nil {
			return nil, err
		}
		items, err := backend.rows("SELECT * FROM folder_items WHERE user_id=?", "guest")
		return Object{"folders": folders, "folderItems": items}, err
	}
	if err := method(request, "POST"); err != nil {
		return nil, err
	}
	fields, err := body(request)
	if err != nil {
		return nil, err
	}
	name, valid := fields["name"].(string)
	if !valid || name == "" {
		return nil, bad("Missing name")
	}
	folder := Object{"id": uuid(), "user_id": "guest", "name": name, "parent_id": fields["parentId"], "order_index": fallback(fields["orderIndex"], 0), "created_at": now(), "updated_at": now()}
	err = insertRow(backend.db, "folders", []string{"id", "user_id", "name", "parent_id", "order_index", "created_at", "updated_at", "color"}, folder, "")
	return Object{"folder": folder}, err
}

func (backend *Server) folder(request *http.Request) (any, error) {
	id := strings.TrimPrefix(request.URL.Path, "/api/folders/")
	if request.Method == "PATCH" {
		fields, err := body(request)
		if err != nil {
			return nil, err
		}
		updates := []string{"updated_at=?"}
		values := []any{now()}
		for _, field := range []struct{ input, column string }{{"name", "name"}, {"parentId", "parent_id"}, {"orderIndex", "order_index"}, {"color", "color"}} {
			if value, exists := fields[field.input]; exists {
				updates = append(updates, field.column+"=?")
				values = append(values, value)
			}
		}
		values = append(values, id, "guest")
		_, err = backend.db.Exec("UPDATE folders SET "+strings.Join(updates, ",")+" WHERE id=? AND user_id=?", values...)
		return Object{"ok": true}, err
	}
	if err := method(request, "DELETE"); err != nil {
		return nil, err
	}
	transaction, err := backend.db.Begin()
	if err != nil {
		return nil, err
	}
	defer transaction.Rollback()
	for _, query := range []string{"DELETE FROM folders WHERE id=? AND user_id=?", "DELETE FROM folder_items WHERE folder_id=? AND user_id=?"} {
		if _, err = transaction.Exec(query, id, "guest"); err != nil {
			return nil, err
		}
	}
	return Object{"ok": true}, transaction.Commit()
}

func (backend *Server) folderItems(request *http.Request) (any, error) {
	if request.Method != "POST" && request.Method != "DELETE" {
		return nil, &HTTPError{405, "Method not allowed"}
	}
	fields, err := body(request)
	if err != nil {
		return nil, err
	}
	items, valid := fields["itemIds"].([]any)
	if text(fields["folderId"]) == "" || !valid {
		return nil, bad("Missing folderId or itemIds")
	}
	transaction, err := backend.db.Begin()
	if err != nil {
		return nil, err
	}
	defer transaction.Rollback()
	for _, item := range items {
		if request.Method == "POST" {
			_, err = transaction.Exec("INSERT INTO folder_items (folder_id,item_id,user_id,created_at) VALUES (?,?,?,?) ON CONFLICT(folder_id,item_id) DO NOTHING", fields["folderId"], item, "guest", now())
		} else {
			_, err = transaction.Exec("DELETE FROM folder_items WHERE folder_id=? AND item_id=? AND user_id=?", fields["folderId"], item, "guest")
		}
		if err != nil {
			return nil, err
		}
	}
	return Object{"ok": true}, transaction.Commit()
}

func (backend *Server) azureKey(request *http.Request) (any, error) {
	switch request.Method {
	case "GET":
		return Object{"hasToken": backend.setting("azure_api_key") != "" || azureEnvironmentKey() != ""}, nil
	case "DELETE":
		_, err := backend.db.Exec("DELETE FROM settings WHERE key='azure_api_key'")
		return Object{"ok": true}, err
	case "POST":
		fields, err := body(request)
		if err != nil {
			return nil, err
		}
		key := strings.TrimSpace(text(fields["azureApiKey"]))
		if key == "" {
			return nil, bad("azureApiKey is required")
		}
		return Object{"ok": true}, backend.setSetting("azure_api_key", key)
	default:
		return nil, &HTTPError{405, "Method not allowed"}
	}
}

func (backend *Server) lookupAsset(request *http.Request) (any, error) {
	hash := request.URL.Query().Get("hash")
	var location any
	if len(hash) == 64 {
		var stored string
		if backend.db.QueryRow("SELECT cdn_url FROM asset_cache WHERE hash=?", hash).Scan(&stored) == nil {
			location = stored
		}
	}
	return Object{"cdnUrl": location}, nil
}

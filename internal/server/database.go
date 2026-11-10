package server

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

func uuid() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	buffer[6] = (buffer[6] & 15) | 64
	buffer[8] = (buffer[8] & 63) | 128
	encoded := hex.EncodeToString(buffer)
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:]
}

func (backend *Server) openDatabase() error {
	filename := filepath.Join(backend.config.DataDir, "guest.db")
	_, existing := os.Stat(filename)
	database, err := sql.Open("sqlite", filename)
	if err != nil {
		return err
	}
	database.SetMaxOpenConns(1)
	backend.db = database
	if _, err = database.Exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;" + schema); err != nil {
		database.Close()
		return err
	}
	if existing == nil && backend.setting("_go_backend_migration") == "" {
		backup := filepath.Join(backend.config.DataDir, "guest-before-go-"+time.Now().UTC().Format("20060102T150405")+".db")
		if _, err = database.Exec("VACUUM INTO ?", backup); err != nil {
			database.Close()
			return fmt.Errorf("Database backup failed: %w", err)
		}
		_ = os.Chmod(backup, 0600)
	}
	if err = backend.importLegacy(); err != nil {
		database.Close()
		return err
	}
	return backend.setSetting("_go_backend_migration", now())
}

func (backend *Server) setting(key string) string {
	var value string
	_ = backend.db.QueryRow("SELECT value FROM settings WHERE key = ?", key).Scan(&value)
	return value
}
func (backend *Server) setSetting(key, value string) error {
	_, err := backend.db.Exec("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value)
	return err
}

func (backend *Server) rows(query string, arguments ...any) ([]Object, error) {
	rows, err := backend.db.Query(query, arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	result := []Object{}
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for index := range values {
			pointers[index] = &values[index]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, err
		}
		record := Object{}
		for index, column := range columns {
			value := values[index]
			if bytes, ok := value.([]byte); ok {
				value = string(bytes)
			}
			record[column] = value
		}
		result = append(result, record)
	}
	return result, rows.Err()
}

var generationColumns = []string{"id", "user_id", "task_id", "generation_type", "status", "prompt", "model", "aspect_ratio", "quality", "azure_resolution", "duration", "kling_mode", "sound", "reference_image_urls", "image_url", "image_urls", "video_url", "error_msg", "created_at", "updated_at"}

func (backend *Server) insertGeneration(value Object) error {
	value = clone(value)
	value["id"] = fallback(value["id"], uuid())
	value["created_at"] = fallback(value["created_at"], now())
	value["updated_at"] = fallback(value["updated_at"], now())
	return insertRow(backend.db, "generations", generationColumns, value, "ON CONFLICT(task_id) DO NOTHING")
}

type executor interface {
	Exec(string, ...any) (sql.Result, error)
}

func insertRow(database executor, table string, columns []string, value Object, conflict string) error {
	arguments := make([]any, len(columns))
	placeholders := make([]string, len(columns))
	for index, column := range columns {
		argument := value[column]
		if column == "image_urls" || column == "reference_image_urls" {
			if argument != nil {
				argument = jsonText(argument)
			}
		}
		if column == "sound" {
			if truth(argument) {
				argument = 1
			} else {
				argument = 0
			}
		}
		if encoded, ok := argument.(json.Number); ok {
			if integer, err := encoded.Int64(); err == nil {
				argument = integer
			} else {
				argument, _ = encoded.Float64()
			}
		}
		arguments[index] = argument
		placeholders[index] = "?"
	}
	_, err := database.Exec("INSERT INTO "+table+" ("+strings.Join(columns, ",")+") VALUES ("+strings.Join(placeholders, ",")+") "+conflict, arguments...)
	return err
}

func (backend *Server) updateGeneration(task string, updates Object) error {
	sets := []string{"updated_at=?"}
	arguments := []any{now()}
	for _, key := range []string{"status", "image_url", "image_urls", "video_url", "error_msg"} {
		if value, exists := updates[key]; exists {
			if key == "image_urls" && value != nil {
				value = jsonText(value)
			}
			sets = append(sets, key+"=?")
			arguments = append(arguments, value)
		}
	}
	arguments = append(arguments, task)
	_, err := backend.db.Exec("UPDATE generations SET "+strings.Join(sets, ",")+" WHERE task_id=?", arguments...)
	return err
}

func generation(row Object) Object {
	for _, column := range []string{"reference_image_urls", "image_urls"} {
		if text(row[column]) != "" {
			var value any
			if json.Unmarshal([]byte(text(row[column])), &value) == nil {
				row[column] = value
			}
		}
	}
	if row["sound"] != nil {
		row["sound"] = number(row["sound"]) != 0
	}
	for key, value := range row {
		if value == nil && key != "user_id" {
			delete(row, key)
		}
	}
	return row
}

func (backend *Server) importLegacy() error {
	for _, source := range []struct{ file, marker string }{{"guest-db.json", "_import_guest_db"}, {"guest-spaces.json", "_import_guest_spaces"}} {
		filename := filepath.Join(backend.config.DataDir, source.file)
		stat, err := os.Stat(filename)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		mtime := fmt.Sprint(float64(stat.ModTime().UnixNano()) / 1e6)
		if backend.setting(source.marker) == mtime {
			continue
		}
		encoded, err := os.ReadFile(filename)
		if err != nil {
			return err
		}
		var data any
		if err := json.Unmarshal(encoded, &data); err != nil {
			return fmt.Errorf("Cannot migrate %s: %w", source.file, err)
		}
		transaction, err := backend.db.Begin()
		if err != nil {
			return err
		}
		if source.file == "guest-spaces.json" {
			spaces := array(data)
			if fields := object(data); len(fields) > 0 {
				spaces = array(fields["spaces"])
			}
			for _, entry := range spaces {
				value := object(entry)
				_, err = transaction.Exec("INSERT INTO spaces (id,name,data,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING", value["id"], fallback(value["name"], "Untitled"), jsonText(value), fallback(value["updatedAt"], fallback(value["createdAt"], time.Now().UnixMilli())))
				if err != nil {
					break
				}
			}
		} else {
			fields := object(data)
			for _, table := range []struct {
				name    string
				columns []string
			}{{"generations", generationColumns}, {"uploads", []string{"id", "user_id", "r2_url", "mime_type", "source", "created_at"}}, {"folders", []string{"id", "user_id", "name", "parent_id", "order_index", "created_at", "updated_at", "color"}}, {"folder_items", []string{"folder_id", "item_id", "user_id", "created_at"}}} {
				for _, entry := range array(fields[table.name]) {
					value := object(entry)
					value["created_at"] = fallback(value["created_at"], now())
					value["updated_at"] = fallback(value["updated_at"], now())
					value["order_index"] = fallback(value["order_index"], 0)
					value["source"] = fallback(value["source"], "user_upload")
					err = insertRow(transaction, table.name, table.columns, value, "ON CONFLICT DO NOTHING")
					if err != nil {
						break
					}
				}
				if err != nil {
					break
				}
			}
			if err == nil {
				for key, value := range object(fields["settings"]) {
					_, err = transaction.Exec("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING", key, text(value))
					if err != nil {
						break
					}
				}
			}
			if err == nil {
				for hash, value := range object(fields["assetCache"]) {
					asset := object(value)
					_, err = transaction.Exec("INSERT INTO asset_cache (hash,cdn_url,mime_type,byte_size) VALUES (?,?,?,?) ON CONFLICT(hash) DO NOTHING", hash, asset["cdn_url"], asset["mime_type"], asset["byte_size"])
					if err != nil {
						break
					}
				}
			}
		}
		if err != nil {
			transaction.Rollback()
			return err
		}
		if err = transaction.Commit(); err != nil {
			return err
		}
		if err = backend.setSetting(source.marker, mtime); err != nil {
			return err
		}
	}
	return nil
}

func (backend *Server) gallery(request *http.Request) (any, error) {
	if request.Method == "DELETE" {
		fields, err := body(request)
		if err != nil {
			return nil, err
		}
		if text(fields["id"]) == "" || text(fields["source"]) == "" {
			return nil, bad("Missing id or source")
		}
		table := "uploads"
		if fields["source"] == "generation" {
			table = "generations"
		}
		_, err = backend.db.Exec("DELETE FROM "+table+" WHERE id=? AND user_id=?", fields["id"], "guest")
		return Object{"ok": true}, err
	}
	if err := method(request, "GET"); err != nil {
		return nil, err
	}
	kind := "image"
	if request.URL.Query().Get("type") == "video" {
		kind = "video"
	}
	source := request.URL.Query().Get("source")
	page := max(0, int(number(request.URL.Query().Get("page"))))
	items := []Object{}
	if source == "" || source == "generation" {
		column := kind + "_url"
		rows, err := backend.rows("SELECT * FROM generations WHERE user_id=? AND generation_type=? AND status='done' AND "+column+" IS NOT NULL AND "+column+"!='' ORDER BY created_at DESC LIMIT 5000", "guest", kind)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			row = generation(row)
			item := Object{"id": row["id"], "url": row[column], "mediaType": kind, "source": "generation", "created_at": row["created_at"]}
			for _, key := range []string{"prompt", "model", "aspect_ratio", "quality", "azure_resolution"} {
				if value, exists := row[key]; exists {
					item[key] = value
				}
			}
			if values := array(row["image_urls"]); len(values) > 0 {
				item["imageUrls"] = values
			}
			if values := array(row["reference_image_urls"]); len(values) > 0 {
				item["referenceImageUrls"] = values
			}
			items = append(items, item)
		}
	}
	if source == "" || source == "upload" {
		rows, err := backend.rows("SELECT * FROM uploads WHERE user_id=? AND COALESCE(mime_type,'') LIKE ?||'%' ORDER BY created_at DESC LIMIT 5000", "guest", kind)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			items = append(items, Object{"id": row["id"], "url": row["r2_url"], "mediaType": kind, "source": "upload", "created_at": row["created_at"]})
		}
	}
	if source == "" {
		seen := map[string]bool{}
		unique := []Object{}
		for _, item := range items {
			location := text(item["url"])
			if location != "" && !seen[location] {
				seen[location] = true
				unique = append(unique, item)
			}
		}
		items = unique
	}
	sort.SliceStable(items, func(first, second int) bool {
		return text(items[first]["created_at"]) > text(items[second]["created_at"])
	})
	offset := min(page*20, len(items))
	end := min(offset+20, len(items))
	return Object{"items": items[offset:end], "total": len(items), "hasMore": len(items) > end}, nil
}

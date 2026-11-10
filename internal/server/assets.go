package server

import (
	"encoding/json"
	"net/http"
	"strings"
)

func (backend *Server) indexAssets() error {
	uploads, err := backend.rows("SELECT uploads.*, COALESCE(NULLIF(uploads.mime_type,''),asset_cache.mime_type,'') AS effective_mime FROM uploads LEFT JOIN asset_cache ON asset_cache.cdn_url=uploads.r2_url WHERE user_id='guest' AND NOT EXISTS (SELECT 1 FROM shared_assets WHERE url=uploads.r2_url) ORDER BY created_at ASC")
	if err != nil {
		return err
	}
	for _, item := range uploads {
		kind := strings.Split(text(item["effective_mime"]), "/")[0]
		if kind != "image" && kind != "video" {
			continue
		}
		if err = backend.indexAsset(text(item["r2_url"]), kind, "upload", "上传素材", "", "", text(item["created_at"])); err != nil {
			return err
		}
	}
	items, err := backend.rows("SELECT * FROM generations WHERE user_id='guest' AND status='done' AND NOT EXISTS (SELECT 1 FROM shared_asset_index WHERE id=generations.id AND COALESCE(updated_at,'')=COALESCE(generations.updated_at,'')) ORDER BY created_at ASC")
	if err != nil {
		return err
	}
	for _, row := range items {
		item := generation(row)
		kind := text(item["generation_type"])
		if kind != "image" && kind != "video" {
			continue
		}
		urls := []any{item[kind+"_url"]}
		if kind == "image" {
			urls = append(urls, array(item["image_urls"])...)
		}
		for _, location := range urls {
			if err = backend.indexAsset(text(location), kind, "generation", "生成素材", text(item["prompt"]), text(item["model"]), text(item["created_at"])); err != nil {
				return err
			}
		}
		if _, err = backend.db.Exec("INSERT OR REPLACE INTO shared_asset_index(id,updated_at) VALUES (?,?)", item["id"], item["updated_at"]); err != nil {
			return err
		}
	}
	return nil
}

func (backend *Server) indexAsset(location, kind, source, title, prompt, model, created string) error {
	if location == "" {
		return nil
	}
	_, err := backend.db.Exec("INSERT OR IGNORE INTO shared_assets (id,url,media_type,source,title,prompt,model,created_at) VALUES (?,?,?,?,?,?,?,?)", "asset-"+uuid(), location, kind, source, title, prompt, model, created)
	if err == nil && source == "generation" {
		_, err = backend.db.Exec("UPDATE shared_assets SET source='generation',prompt=?,model=? WHERE url=?", prompt, model, location)
	}
	return err
}

func (backend *Server) assets(request *http.Request) (any, error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if err := backend.indexAssets(); err != nil {
		return nil, err
	}
	if request.Method == "POST" {
		fields, err := body(request)
		if err != nil {
			return nil, err
		}
		if _, valid := fields["title"].(string); !valid || len(text(fields["title"])) > 500 {
			return nil, bad("素材名称无效")
		}
		var id string
		if err = backend.db.QueryRow("SELECT id FROM shared_assets WHERE url=?", text(fields["url"])).Scan(&id); err != nil {
			return nil, bad("请先上传素材")
		}
		_, err = backend.db.Exec("UPDATE shared_assets SET hidden=0,title=? WHERE id=?", fields["title"], id)
		return Object{"id": id}, err
	}
	if request.Method == "PATCH" || request.Method == "DELETE" {
		fields, err := body(request)
		if err != nil {
			return nil, err
		}
		var count int
		if err = backend.db.QueryRow("SELECT COUNT(*) FROM shared_assets WHERE id=?", text(fields["id"])).Scan(&count); err != nil {
			return nil, err
		}
		if count == 0 {
			return nil, &HTTPError{404, "素材不存在"}
		}
		if request.Method == "DELETE" {
			_, err = backend.db.Exec("UPDATE shared_assets SET hidden=1 WHERE id=?", fields["id"])
		} else {
			if favorite, exists := fields["favorite"]; exists {
				if _, valid := favorite.(bool); !valid {
					return nil, bad("收藏状态无效")
				}
			}
			if title, exists := fields["title"]; exists {
				if _, valid := title.(string); !valid || len(text(title)) > 500 {
					return nil, bad("素材名称过长")
				}
			}
			if tags, exists := fields["tags"]; exists {
				values, valid := tags.([]any)
				if !valid || len(values) > 20 {
					return nil, bad("最多 20 个标签")
				}
				for _, tag := range values {
					if _, valid := tag.(string); !valid || len(text(tag)) > 100 {
						return nil, bad("标签无效")
					}
				}
			}
			for _, field := range []string{"favorite", "title", "tags"} {
				if value, exists := fields[field]; exists {
					if field == "tags" {
						value = jsonText(value)
					}
					if field == "favorite" {
						value = truth(value)
					}
					if _, err = backend.db.Exec("UPDATE shared_assets SET "+field+"=? WHERE id=?", value, fields["id"]); err != nil {
						return nil, err
					}
				}
			}
		}
		return Object{"ok": true}, err
	}
	if err := method(request, "GET"); err != nil {
		return nil, err
	}
	query := request.URL.Query()
	filter, arguments := "hidden=0", []any{}
	if kind := query.Get("type"); kind == "image" || kind == "video" {
		filter += " AND media_type=?"
		arguments = append(arguments, kind)
	}
	if query.Get("favorite") == "true" {
		filter += " AND favorite=1"
	}
	if search := query.Get("q"); search != "" {
		filter += " AND (title LIKE ? OR prompt LIKE ? OR tags LIKE ? OR model LIKE ?)"
		for range 4 {
			arguments = append(arguments, "%"+search+"%")
		}
	}
	var total int
	if err := backend.db.QueryRow("SELECT COUNT(*) FROM shared_assets WHERE "+filter, arguments...).Scan(&total); err != nil {
		return nil, err
	}
	page := min(100000, max(0, int(number(query.Get("page")))))
	limit := 40
	if query.Get("limit") != "" {
		limit = min(100, max(1, int(number(query.Get("limit")))))
	}
	items, err := backend.rows("SELECT * FROM shared_assets WHERE "+filter+" ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?", append(arguments, limit, page*limit)...)
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		item["mediaType"] = item["media_type"]
		item["favorite"] = truth(item["favorite"])
		tags := []any{}
		_ = json.Unmarshal([]byte(text(item["tags"])), &tags)
		item["tags"] = tags
	}
	return Object{"items": items, "total": total, "hasMore": (page+1)*limit < total}, nil
}

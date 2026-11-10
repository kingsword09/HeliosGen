package server

func (backend *Server) dismissIntegrationJobs(jobID string) ([]string, error) {
	if jobID != "" {
		rows, err := backend.rows("SELECT * FROM integration_jobs WHERE id=?", jobID)
		if err != nil {
			return nil, err
		}
		if len(rows) != 1 {
			return nil, &HTTPError{404, "Job not found"}
		}
		job, err := backend.integrationJob(rows[0])
		if err != nil {
			return nil, err
		}
		if !contains([]any{"done", "error", "rejected"}, job["status"]) {
			return nil, &HTTPError{409, "Only completed, failed or rejected messages can be removed"}
		}
	} else if _, err := backend.integrationJobList("", true); err != nil {
		return nil, err
	}
	transaction, err := backend.db.Begin()
	if err != nil {
		return nil, err
	}
	defer transaction.Rollback()
	query := "SELECT id FROM integration_jobs WHERE state IN ('done','error','rejected') AND NOT EXISTS (SELECT 1 FROM integration_inbox_dismissals WHERE job_id=integration_jobs.id)"
	args := []any{}
	if jobID != "" {
		query += " AND id=?"
		args = append(args, jobID)
	}
	rows, err := transaction.Query(query, args...)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		if _, err := transaction.Exec("INSERT INTO integration_inbox_dismissals(job_id,dismissed_at) VALUES(?,?)", id, now()); err != nil {
			return nil, err
		}
	}
	if err := transaction.Commit(); err != nil {
		return nil, err
	}
	return ids, nil
}

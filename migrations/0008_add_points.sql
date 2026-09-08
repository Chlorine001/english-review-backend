
CREATE TABLE user_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  total_points INTEGER DEFAULT 0,
  level TEXT DEFAULT '青铜',
  level_icon TEXT DEFAULT '🥉',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE points_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  points INTEGER NOT NULL,                 -- 正数增加，负数扣除
  type TEXT NOT NULL,                      -- invite_register | daily_login | review_complete | streak | system
  source_id INTEGER,                       -- 关联的源ID（如 invitation_records.id）
  description TEXT,                        -- 描述
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_points_log_user ON points_log(user_id);
CREATE INDEX idx_points_log_created ON points_log(created_at DESC);
CREATE INDEX idx_points_log_type ON points_log(type);
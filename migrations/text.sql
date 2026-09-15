-- migrations/0011_simplify_group_sentences.sql

-- 删除旧表（如果有数据需要保留，先备份）
DROP TABLE IF EXISTS group_sentences;

-- 重建
CREATE TABLE group_sentences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  sentence_id INTEGER NOT NULL,
  likes INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (sentence_id) REFERENCES sentences(id) ON DELETE CASCADE,
  UNIQUE(group_id, sentence_id)
);


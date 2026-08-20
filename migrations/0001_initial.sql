-- 用户表（salt 和 password_hash 分开，因为我们要用 Web Crypto）
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 句子表
CREATE TABLE sentences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  translation TEXT,
  pronunciation TEXT,
  notes TEXT,
  source TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 复习记录表（含核心算法字段）
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sentence_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEW',
  interval_days INTEGER DEFAULT 0,
  ease_factor REAL DEFAULT 2.5,
  review_count INTEGER DEFAULT 0,
  correct_count INTEGER DEFAULT 0,
  last_review_at DATETIME,
  next_review_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sentence_id) REFERENCES sentences(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 索引（加速查询，类似 MySQL 的 KEY）
CREATE INDEX idx_reviews_user_next ON reviews(user_id, next_review_at);
CREATE INDEX idx_sentences_user ON sentences(user_id);
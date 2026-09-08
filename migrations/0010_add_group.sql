CREATE TABLE groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  avatar TEXT,
  owner_id INTEGER NOT NULL,          -- 创建者
  invite_code TEXT UNIQUE NOT NULL,   -- 邀请码
  is_public BOOLEAN DEFAULT 1,        -- 是否公开
  max_members INTEGER DEFAULT 20,     -- 最大成员数
  member_count INTEGER DEFAULT 1,     -- 当前成员数
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT DEFAULT 'member',          -- owner | admin | member
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active_at DATETIME,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(group_id, user_id)
);

CREATE TABLE group_sentences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,            -- 贡献者
  sentence_id INTEGER NOT NULL,        -- 引用的原始句子
  content TEXT NOT NULL,
  translation TEXT,
  pronunciation TEXT,
  source TEXT,
  likes INTEGER DEFAULT 0,             -- 点赞数
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (sentence_id) REFERENCES sentences(id) ON DELETE CASCADE
);

CREATE TABLE group_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,                  -- join | share | review | like
  content TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
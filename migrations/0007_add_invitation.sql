CREATE TABLE invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,        -- 邀请人（唯一，一个用户只有一条）
  code TEXT UNIQUE NOT NULL,               -- 唯一邀请码
  total_invited INTEGER DEFAULT 0,          -- 总邀请人数
  registered_count INTEGER DEFAULT 0,       -- 已注册人数
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 邀请记录表（记录每次邀请的详情）
CREATE TABLE invitation_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invitation_id INTEGER NOT NULL,           -- 关联 invitations.id
  invitee_email TEXT,                       -- 被邀请人邮箱
  invitee_id INTEGER,                       -- 被邀请人用户ID（注册后关联）
  status TEXT DEFAULT 'pending',            -- pending | registered
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  registered_at DATETIME,
  FOREIGN KEY (invitation_id) REFERENCES invitations(id) ON DELETE CASCADE,
  FOREIGN KEY (invitee_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_invitation_records_invitation ON invitation_records(invitation_id);
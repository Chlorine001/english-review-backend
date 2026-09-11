-- ========== 小组索引优化 ==========

-- groups 表：按创建者查询、按邀请码查询
CREATE INDEX IF NOT EXISTS idx_groups_owner ON groups(owner_id);
CREATE INDEX IF NOT EXISTS idx_groups_invite_code ON groups(invite_code);
CREATE INDEX IF NOT EXISTS idx_groups_created_at ON groups(created_at DESC);

-- group_members 表：按小组查成员、按用户查小组
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_group_members_group_user ON group_members(group_id, user_id);
CREATE INDEX IF NOT EXISTS idx_group_members_role ON group_members(group_id, role);

-- group_activities 表：按小组查动态（最常用）
CREATE INDEX IF NOT EXISTS idx_group_activities_group_created 
  ON group_activities(group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_group_activities_user 
  ON group_activities(user_id);

-- group_sentences 表：按小组查句子
CREATE INDEX IF NOT EXISTS idx_group_sentences_group 
  ON group_sentences(group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_group_sentences_user 
  ON group_sentences(user_id);
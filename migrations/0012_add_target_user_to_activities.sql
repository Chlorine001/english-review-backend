-- 增加被操作人字段
ALTER TABLE group_activities ADD COLUMN target_user_id INTEGER;

-- 增加索引（可选，用于查询"谁被操作过"）
CREATE INDEX IF NOT EXISTS idx_group_activities_target 
  ON group_activities(target_user_id);
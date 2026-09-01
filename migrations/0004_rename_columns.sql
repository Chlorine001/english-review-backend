-- 重命名列
ALTER TABLE sentences RENAME COLUMN audio_path TO media_path;
ALTER TABLE sentences RENAME COLUMN audio_original_name TO media_original_name;
ALTER TABLE sentences RENAME COLUMN audio_format TO media_format;

-- 删除列
ALTER TABLE sentences DROP COLUMN audio_duration;

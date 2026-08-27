-- 在 sentences 表中增加音频相关字段：
ALTER TABLE sentences ADD COLUMN audio_path TEXT;          -- R2 对象键，如 "sentences/123.mp3"
ALTER TABLE sentences ADD COLUMN audio_duration REAL;     -- 音频时长（秒）
ALTER TABLE sentences ADD COLUMN audio_format TEXT;       -- 如 "mp3"，用于前端
-- 若您未来支持用户录制上传，还需一张 audio_uploads 日志表（非必须），便于追踪。
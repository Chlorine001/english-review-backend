-- 用户表增加验证相关字段
ALTER TABLE users ADD COLUMN is_verified BOOLEAN DEFAULT 0;
ALTER TABLE users ADD COLUMN verification_code TEXT;
ALTER TABLE users ADD COLUMN verification_code_expires_at DATETIME;
ALTER TABLE users ADD COLUMN email_verified_at DATETIME;

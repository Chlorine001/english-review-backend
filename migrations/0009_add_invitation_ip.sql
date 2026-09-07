-- 扩展 invitation_records 表
ALTER TABLE invitation_records ADD COLUMN ip_address TEXT;
ALTER TABLE invitation_records ADD COLUMN user_agent TEXT;
ALTER TABLE invitation_records ADD COLUMN device_type TEXT;

CREATE INDEX idx_invitation_records_ip ON invitation_records(ip_address);
// ---------- 扩展 Bindings 类型 ----------
export interface Bindings {
    DB: D1Database;
    JWT_SECRET: string;
}

export interface inviteBindings extends Bindings {
    FRONTEND_URL: string;
}

export interface authBindings extends Bindings {
    EMAIL_FROM: string;
    RESEND_API_KEY: string;
    FRONTEND_URL: string;
    JWT_EXPIRES_IN: string;   // 以分钟为单位的字符串
}

export interface mediaBindings extends Bindings {
    R2_BUCKET: R2Bucket;
    MAX_FILE_SIZE?: string;
}

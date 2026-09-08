// 允许的 MIME 类型
export const ALLOWED_MEDIA_TYPES = [
    'audio/mpeg',      // mp3
    'audio/mp3',
    'audio/mp4',       // m4a
    'audio/x-m4a',
    'audio/wav',
    'video/mp4',       // mp4 视频
    'video/webm',
    'video/quicktime', // mov
];

// 允许的文件扩展名
export const ALLOWED_MEDIA_EXTS = ['mp3', 'm4a', 'wav', 'mp4', 'webm', 'mov'];

// 默认文件大小限制（单位：字节），可由环境变量覆盖
export const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
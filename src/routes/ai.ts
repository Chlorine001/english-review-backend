import { authenticate } from '../utils/auth';
import { Hono } from 'hono';
import {
    ALLOWED_MEDIA_TYPES,
    ALLOWED_MEDIA_EXTS,
    DEFAULT_MAX_FILE_SIZE,
} from '../types/media';
import { requireVerified } from '../utils/verify';
import { Buffer } from 'node:buffer';

import { aiBindings } from '../types/bindings';
export const aiRoutes = new Hono<{ Bindings: aiBindings }>();
aiRoutes.get('/test', async (c) => {
    console.log('AI binding:', c.env.AI);
    return c.json({
        hasAI: !!c.env.AI,
        type: typeof c.env.AI,
    });
});

aiRoutes.post('/analyze', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    // ✅ 检查是否已验证
    const result = await requireVerified(c.env.DB, auth.userId);
    if (!result.verified) {
        return c.json({ error: '请先验证邮箱后再使用AI功能！', code: 'EMAIL_NOT_VERIFIED' }, 403);
    }

    try {
        const formData = await c.req.formData();
        const file = formData.get('media') as File;
        if (!file) return c.json({ error: 'No media file' }, 400);

        const maxSize = Number(c.env.MAX_FILE_SIZE) || DEFAULT_MAX_FILE_SIZE; // 环境变量-- Number(c.env.MAX_FILE_SIZE)

        const ext = file.name.split('.').pop()?.toLowerCase();
        if (!ALLOWED_MEDIA_TYPES.includes(file.type) || !ext || !ALLOWED_MEDIA_EXTS.includes(ext)) {
            return c.json({ error: `不支持的文件格式，仅支持: ${ALLOWED_MEDIA_EXTS.join(', ')}` }, 400);
        }
        if (file.size > maxSize) {
            return c.json({ error: `文件大小不能超过 ${maxSize / 1024 / 1024}MB` }, 413);
        }

        // 1. 转成 ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();
        // ✅ 转成 Base64 字符串
        const base64Audio = Buffer.from(arrayBuffer).toString('base64');
        // 2. Whisper 转录（音视频 → 文本）
        const transcription = await c.env.AI.run('@cf/openai/whisper-large-v3-turbo', {
            audio: base64Audio,
            // 可选：显式指定语言能提升准确率
            language: 'en',        // 或 'zh'，根据音频内容
            // 可选：指定任务是转写还是翻译
            task: 'transcribe',    // 或 'translate'
        });

        const text = (transcription as any).text || '';
        if (!text.trim()) {
            return c.json({ error: '未识别到文本，请确认文件包含语音' }, 400);
        }

        // 3. 翻译（英 → 中）
        let translation = '';
        try {
            const translationResult = await c.env.AI.run('@cf/meta/m2m100-1.2b', {
                text,
                source_lang: 'en',
                target_lang: 'zh',
            });
            translation = (translationResult as any).translated_text || '';
        } catch (err) {
            console.warn('翻译失败:', err);
        }

        return c.json({ text, translation });
    } catch (err: any) {
        console.error('AI 识别失败:', err);
        return c.json({ error: err.message || 'AI 识别失败' }, 500);
    }
});
import { authenticate } from '../utils/auth';
import { Hono } from 'hono';
import {
    ALLOWED_MEDIA_TYPES,
    ALLOWED_MEDIA_EXTS,
    DEFAULT_MAX_FILE_SIZE,
} from '../types/media';
import { requireVerified } from '../utils/verify';

import { mediaBindings } from '../types/bindings';
export const sentenceRoutes = new Hono<{ Bindings: mediaBindings }>();

// ---------- 添加句子（需要认证） ----------
sentenceRoutes.post('/', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: '非法访问！' }, 401);

    const { content, translation, pronunciation, notes, source } = await c.req.json();
    if (!content) return c.json({ error: 'Content is required' }, 400);

    // 插入句子
    const stmt = c.env.DB.prepare(
        'INSERT INTO sentences (user_id, content, translation, pronunciation, notes, source) VALUES (?, ?, ?, ?, ?, ?) RETURNING id'
    );
    const result = await stmt.bind(auth.userId, content, translation || '', pronunciation || '', notes || '', source || '').first<{ id: number }>();
    if (!result) {
        return c.json({ error: '添加失败！' }, 500);
    }
    // 同时创建初始复习记录（第一次学习）
    const now = new Date().toISOString();
    const reviewStmt = c.env.DB.prepare(
        'INSERT INTO reviews (sentence_id, user_id, status, next_review_at) VALUES (?, ?, ?, ?)'
    );
    await reviewStmt.bind(result.id, auth.userId, 'NEW', now).run();

    return c.json({ id: result.id }, 201);
});

// ---------- 更新句子 ----------
sentenceRoutes.put('/:id', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const id = Number(c.req.param('id'));
    const { content, translation, pronunciation, notes, source } = await c.req.json();

    // 先验证该句子属于当前用户
    const check = await c.env.DB.prepare('SELECT id FROM sentences WHERE id = ? AND user_id = ?')
        .bind(id, auth.userId).first();
    if (!check) return c.json({ error: 'Sentence not found' }, 404);

    await c.env.DB.prepare(`
    UPDATE sentences
    SET content = ?, translation = ?, pronunciation = ?, notes = ?, source = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(content, translation || '', pronunciation || '', notes || '', source || '', id).run();

    return c.json({ success: true });
});

// ---------- 获取所有句子（支持搜索和排序） ----------
sentenceRoutes.get('/', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const url = new URL(c.req.url);
    const search = url.searchParams.get('search') || '';
    const sort = url.searchParams.get('sort') || 'created_at_desc';

    // 分页参数（前端默认 page=1, limit=20）
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const offset = (page - 1) * limit;

    // 基础查询条件（始终包含 user_id）
    let whereClause = 'WHERE user_id = ?';
    const params: any[] = [auth.userId];

    if (search) {
        whereClause += ' AND content LIKE ?';
        params.push(`%${search}%`);
    }

    // 排序逻辑
    let orderClause = '';
    switch (sort) {
        case 'created_at_asc':
            orderClause = 'ORDER BY created_at ASC';
            break;
        case 'content_asc':
            orderClause = 'ORDER BY content ASC';
            break;
        case 'content_desc':
            orderClause = 'ORDER BY content DESC';
            break;
        default:
            orderClause = 'ORDER BY created_at DESC';
    }

    // 1. 查询总记录数（用于前端分页控件）
    const countSql = `SELECT COUNT(*) AS total FROM sentences ${whereClause}`;
    const countResult = await c.env.DB.prepare(countSql).bind(...params).first();
    const total = countResult?.total || 0;

    // 2. 查询分页数据
    const dataSql = `
    SELECT *
    FROM sentences
    ${whereClause}
    ${orderClause}
    LIMIT ? OFFSET ?
  `;
    // 注意：LIMIT 和 OFFSET 需要追加到参数列表末尾
    const dataParams = [...params, limit, offset];
    const { results } = await c.env.DB.prepare(dataSql).bind(...dataParams).all();

    // 返回前端期望的格式
    return c.json({
        data: results,
        total: total,
    });
});

// ---------- 删除句子 ----------
sentenceRoutes.delete('/api/sentences/:id', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const id = Number(c.req.param('id'));
    // 验证权限（同时删句子和关联的复习记录，因为外键级联删除）
    const check = await c.env.DB.prepare('SELECT id FROM sentences WHERE id = ? AND user_id = ?')
        .bind(id, auth.userId).first();
    if (!check) return c.json({ error: 'Sentence not found' }, 404);

    await c.env.DB.prepare('DELETE FROM sentences WHERE id = ?').bind(id).run();
    return c.json({ success: true });
});

//上传音频
sentenceRoutes.post('/api/sentences/:id/media', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    // ✅ 检查是否已验证
    const result = await requireVerified(c.env.DB, auth.userId);
    if (!result.verified) {
        return c.json({ error: '请先验证邮箱后上传音频！', code: 'EMAIL_NOT_VERIFIED' }, 403);
    }

    const id = Number(c.req.param('id'));
    // 验证句子属于当前用户
    const sentence = await c.env.DB.prepare('SELECT user_id FROM sentences WHERE id = ?').bind(id).first();
    if (!sentence || sentence.user_id !== auth.userId) return c.json({ error: 'Not found' }, 404);

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

    // 生成path
    const originalName = file.name; // 获取原始文件名
    const path = `sentences/${id}.${ext}`;
    const mimeMap: Record<string, string> = {
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        wav: 'audio/wav',
        mp4: 'video/mp4',
        webm: 'video/webm',
        mov: 'video/quicktime',
    };
    // 上传到 R2
    const arrayBuffer = await file.arrayBuffer();
    await c.env.R2_BUCKET.put(path, arrayBuffer, {

        httpMetadata: { contentType: mimeMap[ext || ''] || 'application/octet-stream' },
    });

    // 更新数据库
    await c.env.DB.prepare(
        'UPDATE sentences SET media_path = ?, media_format = ?, media_original_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind(path, ext, originalName, id).run();

    return c.json({ success: true, path: path, originalName: originalName });
});

sentenceRoutes.get('/api/sentences/:id/media', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const id = Number(c.req.param('id'));
    const sentence = await c.env.DB.prepare(
        'SELECT media_path FROM sentences WHERE id = ? AND user_id = ?'
    ).bind(id, auth.userId).first<{ media_path: string }>();

    if (!sentence || !sentence.media_path) {
        return c.json({ error: 'Media not found' }, 404);
    }

    const object = await c.env.R2_BUCKET.get(sentence.media_path);
    if (!object) {
        return c.json({ error: 'File missing' }, 404);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    const ext = sentence.media_path?.split('.').pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        wav: 'audio/wav',
        mp4: 'video/mp4',
        webm: 'video/webm',
        mov: 'video/quicktime',
    };
    headers.set('Content-Type', mimeMap[ext || ''] || 'application/octet-stream');
    headers.set('Cache-Control', 'public, max-age=86400');

    // 直接返回完整流，不处理 Range
    return new Response(object.body, { status: 200, headers });
});

// ---------- 删除音频 ----------
sentenceRoutes.delete('/api/sentences/:id/media', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    // ✅ 检查是否已验证
    const result = await requireVerified(c.env.DB, auth.userId);
    if (!result.verified) {
        return c.json({ error: '请先验证邮箱后才可以删除音频！', code: 'EMAIL_NOT_VERIFIED' }, 403);
    }

    const id = Number(c.req.param('id'));
    // 1. 验证句子归属
    const sentence = await c.env.DB.prepare('SELECT media_path FROM sentences WHERE id = ? AND user_id = ?')
        .bind(id, auth.userId).first<{ media_path: string }>();
    if (!sentence) return c.json({ error: 'Sentence not found' }, 404);
    if (!sentence.media_path) return c.json({ error: 'No media to delete' }, 404);

    // 2. 从 R2 删除文件
    await c.env.R2_BUCKET.delete(sentence.media_path);

    // 3. 清空数据库字段
    await c.env.DB.prepare('UPDATE sentences SET media_path = NULL, media_format = NULL, media_original_name = NULL WHERE id = ?')
        .bind(id).run();

    return c.json({ success: true });
});


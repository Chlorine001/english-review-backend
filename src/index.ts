// src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import {
  generateSalt, hashPassword, verifyPassword,
  signJWT, authenticate
} from './auth';

// ---------- 扩展 Bindings 类型 ----------
type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;   // 以分钟为单位的字符串
  R2_BUCKET: R2Bucket;
};

const app = new Hono<{ Bindings: Bindings }>();

// 只允许你的前端域名和本地开发环境
app.use('/*', cors({
  origin: (origin) => {
    // 生产前端域名
    if (origin === 'https://lexiscribe.cdragon.win') return origin;
    // 本地开发（可选）
    if (origin && (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))) return origin;
    return null; // 拒绝其他来源
  },
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}));

// 全局错误处理（必须放在所有路由之前）
app.onError((err, c) => {
  console.error('❌ Error:', err);
  return c.json({ error: err.message || '服务器内部错误，请稍后重试！' }, 500);
});

// 健康检查 & 根路径
app.get('/', (c) => {
  return c.json({ status: 'ok', message: '✅ API服务运行正常！' });
});

// ---------- 注册（类似 @PostMapping("/register")） ----------
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});
// const registerSchema = z.object({
//   email: z.string().email({ message: '邮箱格式不正确!' }),
//   password: z.string().min(6, { message: '密码长度至少为 6 个字符' }),
// });

app.post('/api/auth/register', zValidator('json', registerSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);

  try {
    const stmt = c.env.DB.prepare(
      'INSERT INTO users (email, salt, password_hash) VALUES (?, ?, ?) RETURNING id'
    );
    const result = await stmt.bind(email, salt, hash).first<{ id: number }>();
    // 防止返回了空对象或字符串类型的 id
    if (!result || typeof result.id !== 'number') {
      return c.json({ error: '非法注册！' }, 500);
    }
    // ✅ 修改：传入 secret 和过期分钟数
    const token = await signJWT(
      { userId: result.id, email },
      c.env.JWT_SECRET,
      parseInt(c.env.JWT_EXPIRES_IN)
    );
    // ✅ 修改：传入 secret 和过期分钟数
    const expiresInMinutes = parseInt(c.env.JWT_EXPIRES_IN) || 60; // 默认 60 分钟
    // 返回 JSON 同时设置 HttpOnly Cookie
    return c.json(
      { user: { id: result.id, email } },
      {
        headers: {
          'Set-Cookie': `token=${token}; HttpOnly; Path=/; Max-Age=${expiresInMinutes * 60}; SameSite=None; Secure`,
        },
      }
    );
  } catch (err: any) {
    // 捕获 UNIQUE 约束冲突（邮箱重复）
    if (err?.message?.includes('UNIQUE constraint failed')) {
      return c.json({ error: '用户已存在，请直接登录！' }, 409);
    }
    // 其他未知错误
    console.error('Registration error:', err);
    return c.json({ error: '未知错误！请联系管理员！' }, 500);
  }
});

// ---------- 登录 ----------
app.post('/api/auth/login', zValidator('json', registerSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const user = await c.env.DB.prepare(
    'SELECT id, email, salt, password_hash FROM users WHERE email = ?'
  ).bind(email).first<{ id: number; email: string; salt: string; password_hash: string }>();
  if (!user) {
    return c.json({ error: '用户不存在！请先注册！' }, 401);
  }
  const isValid = await verifyPassword(password, user.salt, user.password_hash);
  if (!isValid) {
    return c.json({ error: '用户或密码不正确！' }, 401);
  }
  // ✅ 修改：传入 secret 和过期分钟数
  const expiresInMinutes = parseInt(c.env.JWT_EXPIRES_IN) || 60; // 默认 60 分钟
  const token = await signJWT(
    { userId: user.id, email: user.email },
    c.env.JWT_SECRET,
    expiresInMinutes
  );
  // 返回 JSON 同时设置 HttpOnly Cookie
  return c.json(
    { user: { id: user.id, email: user.email } },
    {
      headers: {
        'Set-Cookie': `token=${token}; HttpOnly; Path=/; Max-Age=${expiresInMinutes * 60}; SameSite=None; Secure`,
      },
    }
  );
});

app.post('/api/auth/logout', async (c) => {
  // 即使没有携带有效 token，也清除 Cookie（无状态注销）
  // 但如果你希望只有登录用户才能注销，可以调用 authenticate
  // 这里直接清除 Cookie 即可

  return c.json(
    { success: true, message: '已退出登录' },
    {
      headers: {
        'Set-Cookie': 'token=; HttpOnly; Path=/; Max-Age=0; SameSite=None; Secure',
      },
    }
  );
});

// ---------- 添加句子（需要认证） ----------
app.post('/api/sentences', async (c) => {
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

// ---------- 获取今日复习队列 ----------
app.get('/api/reviews/today', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: '非法访问！' }, 401);

  const now = new Date().toISOString();
  const sql = `
    SELECT s.*, r.id as review_id, r.status, r.interval_days, r.ease_factor, r.review_count
    FROM sentences s
    JOIN reviews r ON s.id = r.sentence_id
    WHERE r.user_id = ? AND r.next_review_at <= ? AND r.status != 'MATURE'
    ORDER BY r.next_review_at ASC
    LIMIT 20
  `;
  const { results } = await c.env.DB.prepare(sql).bind(auth.userId, now).all();
  return c.json(results);
});

// ---------- 提交复习评价 ----------
app.post('/api/reviews/:id/answer', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: '非法访问！' }, 401);

  const reviewId = Number(c.req.param('id'));
  const { rating } = await c.req.json(); // 'again', 'hard', 'good', 'easy'

  // 获取当前 review 记录
  const review = await c.env.DB.prepare(
    'SELECT * FROM reviews WHERE id = ? AND user_id = ?'
  ).bind(reviewId, auth.userId).first<any>();
  if (!review) return c.json({ error: 'Not found' }, 404);

  // 计算新间隔（简单版算法，你可以自己调整）
  let intervalDays = review.interval_days || 0;
  let ease = review.ease_factor || 2.5;

  switch (rating) {
    case 'again':
      intervalDays = Math.max(1, Math.floor(intervalDays * 0.3));
      ease = Math.max(1.3, ease - 0.2);
      break;
    case 'hard':
      intervalDays = Math.max(1, Math.floor(intervalDays * 0.7));
      ease = Math.max(1.3, ease - 0.1);
      break;
    case 'good':
      if (intervalDays === 0) intervalDays = 1;
      else intervalDays = Math.floor(intervalDays * ease);
      break;
    case 'easy':
      if (intervalDays === 0) intervalDays = 3;
      else intervalDays = Math.floor(intervalDays * ease * 1.3);
      ease = Math.min(5.0, ease + 0.15);
      break;
    default:
      return c.json({ error: 'Invalid rating' }, 400);
  }
  intervalDays = Math.min(intervalDays, 180);

  const nextReviewAt = new Date();
  nextReviewAt.setDate(nextReviewAt.getDate() + intervalDays);

  // 确定状态（简单逻辑）
  const newReviewCount = (review.review_count || 0) + 1;
  let newStatus = review.status;
  if (newReviewCount <= 1) newStatus = 'LEARNING';
  else if (newReviewCount <= 3) newStatus = 'REVIEW';
  else if (newReviewCount > 5 && rating !== 'again') newStatus = 'MATURE';

  const correctIncrement = (rating === 'again' || rating === 'hard') ? 0 : 1;

  await c.env.DB.prepare(`
    UPDATE reviews
    SET status = ?,
        interval_days = ?,
        ease_factor = ?,
        review_count = ?,
        correct_count = correct_count + ?,
        last_review_at = ?,
        next_review_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    newStatus,
    intervalDays,
    ease,
    newReviewCount,
    correctIncrement,
    new Date().toISOString(),
    nextReviewAt.toISOString(),
    reviewId
  ).run();

  return c.json({ success: true });
});

// 可选：统计接口（Dashboard 用）
app.get('/api/stats', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const now = new Date().toISOString();
  const todayCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM reviews WHERE user_id = ? AND next_review_at <= ? AND status != "MATURE"'
  ).bind(auth.userId, now).first<{ count: number }>();

  const totalCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM sentences WHERE user_id = ?'
  ).bind(auth.userId).first<{ count: number }>();

  // 简单返回
  return c.json({
    today: todayCount?.count || 0,
    total: totalCount?.count || 0,
  });
});

// ---------- 获取所有句子（支持搜索和排序） ----------
app.get('/api/sentences', async (c) => {
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

// ---------- 更新句子 ----------
app.put('/api/sentences/:id', async (c) => {
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

// ---------- 删除句子 ----------
app.delete('/api/sentences/:id', async (c) => {
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
app.post('/api/sentences/:id/audio', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const id = Number(c.req.param('id'));
  // 验证句子属于当前用户
  const sentence = await c.env.DB.prepare('SELECT user_id FROM sentences WHERE id = ?').bind(id).first();
  if (!sentence || sentence.user_id !== auth.userId) return c.json({ error: 'Not found' }, 404);

  const formData = await c.req.formData();
  const file = formData.get('audio') as File;
  if (!file) return c.json({ error: 'No audio file' }, 400);

  // 生成path
  const originalName = file.name; // 获取原始文件名
  const ext = file.name.split('.').pop() || 'mp3';
  const path = `sentences/${id}.${ext}`;

  // 上传到 R2
  const arrayBuffer = await file.arrayBuffer();
  await c.env.R2_BUCKET.put(path, arrayBuffer, {
    httpMetadata: { contentType: file.type || 'audio/mpeg' },
  });

  // 获取时长（可用第三方库，简化：由前端传入或后续解析）
  // 此处让前端在 upload 后回传 duration，或使用 ffmpeg 在 Worker 中解析（消耗 CPU，不推荐）

  // 更新数据库
  await c.env.DB.prepare(
    'UPDATE sentences SET audio_path = ?, audio_format = ?, audio_original_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).bind(path, ext, originalName, id).run();

  return c.json({ success: true, path: path, originalName: originalName });
});

app.get('/api/sentences/:id/audio', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const id = Number(c.req.param('id'));
  const sentence = await c.env.DB.prepare(
    'SELECT audio_path FROM sentences WHERE id = ? AND user_id = ?'
  ).bind(id, auth.userId).first<{ audio_path: string }>();

  if (!sentence || !sentence.audio_path) {
    return c.json({ error: 'Audio not found' }, 404);
  }

  const object = await c.env.R2_BUCKET.get(sentence.audio_path);
  if (!object) {
    return c.json({ error: 'File missing' }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', 'audio/mpeg');
  headers.set('Cache-Control', 'public, max-age=86400');

  // 直接返回完整流，不处理 Range
  return new Response(object.body, { status: 200, headers });
});

// ---------- 删除音频 ----------
app.delete('/api/sentences/:id/audio', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const id = Number(c.req.param('id'));
  // 1. 验证句子归属
  const sentence = await c.env.DB.prepare('SELECT audio_path FROM sentences WHERE id = ? AND user_id = ?')
    .bind(id, auth.userId).first<{ audio_path: string }>();
  if (!sentence) return c.json({ error: 'Sentence not found' }, 404);
  if (!sentence.audio_path) return c.json({ error: 'No audio to delete' }, 404);

  // 2. 从 R2 删除文件
  await c.env.R2_BUCKET.delete(sentence.audio_path);

  // 3. 清空数据库字段
  await c.env.DB.prepare('UPDATE sentences SET audio_path = NULL, audio_duration = NULL, audio_format = NULL WHERE id = ?')
    .bind(id).run();

  return c.json({ success: true });
});

export default app;

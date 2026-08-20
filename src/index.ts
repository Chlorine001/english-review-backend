// src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { 
  generateSalt, hashPassword, verifyPassword, 
  signJWT, authenticate 
} from './auth';

// 类型声明：让 Hono 能识别我们的 D1 绑定
type Bindings = {
  DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

// 允许跨域（前端开发时要用）
app.use('/*', cors());

// ---------- 注册（类似 @PostMapping("/register")） ----------
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

app.post('/api/auth/register', zValidator('json', registerSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);

  // 插入数据库，类似 JPA 的 save
  const stmt = c.env.DB.prepare(
    'INSERT INTO users (email, salt, password_hash) VALUES (?, ?, ?) RETURNING id'
  );
  const result = await stmt.bind(email, salt, hash).first<{ id: number }>();
  if (!result) {
    return c.json({ error: 'Email already exists' }, 400);
  }
  const token = await signJWT({ userId: result.id, email });
  return c.json({ token, user: { id: result.id, email } });
});

// ---------- 登录（类似 @PostMapping("/login")） ----------
app.post('/api/auth/login', zValidator('json', registerSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const user = await c.env.DB.prepare(
    'SELECT id, email, salt, password_hash FROM users WHERE email = ?'
  ).bind(email).first<{ id: number; email: string; salt: string; password_hash: string }>();
  if (!user) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }
  const isValid = await verifyPassword(password, user.salt, user.password_hash);
  if (!isValid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }
  const token = await signJWT({ userId: user.id, email: user.email });
  return c.json({ token, user: { id: user.id, email: user.email } });
});

// ---------- 添加句子（需要认证） ----------
app.post('/api/sentences', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const { content, translation, pronunciation, notes, source } = await c.req.json();
  if (!content) return c.json({ error: 'Content is required' }, 400);

  // 插入句子
  const stmt = c.env.DB.prepare(
    'INSERT INTO sentences (user_id, content, translation, pronunciation, notes, source) VALUES (?, ?, ?, ?, ?, ?) RETURNING id'
  );
  const result = await stmt.bind(auth.userId, content, translation || '', pronunciation || '', notes || '', source || '').first<{ id: number }>();

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
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

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
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

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

export default app;
// src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import {
  generateSalt, hashPassword, verifyPassword,
  signJWT, authenticate
} from './auth';
import { Resend } from 'resend';

import {
  ALLOWED_MEDIA_TYPES,
  ALLOWED_MEDIA_EXTS,
  DEFAULT_MAX_FILE_SIZE,
} from './constants';

// ---------- 扩展 Bindings 类型 ----------
type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;   // 以分钟为单位的字符串
  R2_BUCKET: R2Bucket;
  MAX_FILE_SIZE?: string;
  EMAIL_FROM: string;
  RESEND_API_KEY: string;
  FRONTEND_URL: string;
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
  maxAge: 86400, // ✅ 缓存预检结果 24 小时（单位：秒）
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
  const { email, password, refCode } = await c.req.json();
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
    // 传入 secret 和过期分钟数
    const token = await signJWT(
      { userId: result.id, email },
      c.env.JWT_SECRET,
      parseInt(c.env.JWT_EXPIRES_IN)
    );

    if (refCode) {
      const invite = await c.env.DB.prepare(
        'SELECT id, user_id FROM invitations WHERE code = ?'
      ).bind(refCode).first<{ id: number; user_id: number }>();

      if (invite) {
        // 更新 invitation_records：关联新用户
        await c.env.DB.prepare(
          `UPDATE invitation_records 
           SET invitee_id = ?, invitee_email = ?, status = 'registered', registered_at = CURRENT_TIMESTAMP
           WHERE invitation_id = ? AND status = 'accepted'
           ORDER BY created_at ASC LIMIT 1`
        ).bind(result.id, email, invite.id).run();

        // 更新邀请统计
        await c.env.DB.prepare(
          `UPDATE invitations 
         SET registered_count = registered_count + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
        ).bind(invite.id).run();
      }
    }

    // 传入 secret 和过期分钟数
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

// ---------- 发送验证码 ----------
app.post('/api/auth/send-verification', async (c) => {
  const { email } = await c.req.json();
  if (!email) return c.json({ error: '邮箱不能为空' }, 400);

  // 检查用户是否存在
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (!user) return c.json({ error: '用户不存在' }, 404);

  // 生成 6 位数字验证码
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 分钟

  // 保存验证码
  await c.env.DB.prepare(
    'UPDATE users SET verification_code = ?, verification_code_expires_at = ? WHERE email = ?'
  ).bind(code, expiresAt.toISOString(), email).run();

  // 发送邮件
  const resend = new Resend(c.env.RESEND_API_KEY);
  const frontendUrl = c.env.FRONTEND_URL || 'http://localhost:5173';
  const verifyLink = `${frontendUrl}/verify-email?email=${encodeURIComponent(email)}`;

  await resend.emails.send({
    from: c.env.EMAIL_FROM,
    to: email,
    subject: 'LexiScribe 邮箱验证码',
    html: `
      <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 16px; background: #ffffff;">
        <h2 style="color: #4f46e5; font-size: 24px; margin-top: 0;">✒️ LexiScribe</h2>
        <p style="font-size: 16px; color: #1f2937;">感谢注册 LexiScribe，请使用以下验证码完成邮箱验证：</p>
        <div style="font-size: 40px; font-weight: bold; letter-spacing: 10px; text-align: center; background: #f3f4f6; padding: 16px 24px; border-radius: 12px; margin: 20px 0; color: #1f2937;">
          ${code}
        </div>
        <p style="color: #6b7280; font-size: 14px;">验证码有效期为 10 分钟，请尽快使用。</p>
        <p style="margin: 20px 0 10px;">
          <a href="${verifyLink}" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500;">
            点击验证邮箱
          </a>
        </p>
        <p style="color: #9ca3af; font-size: 12px; border-top: 1px solid #e5e7eb; padding-top: 16px; margin-top: 16px;">
          如果按钮无法点击，请复制以下链接到浏览器：<br />
          <span style="word-break: break-all; color: #4f46e5;">${verifyLink}</span>
        </p>
        <p style="color: #9ca3af; font-size: 12px;">此邮件由 LexiScribe 自动发送，请勿回复。</p>
      </div>
    `,
  });

  return c.json({ success: true, message: '验证码已发送' });
});

// ---------- 验证邮箱 ----------
app.post('/api/auth/verify-email', async (c) => {
  const { email, code } = await c.req.json();
  if (!email || !code) return c.json({ error: '邮箱和验证码不能为空' }, 400);

  const user = await c.env.DB.prepare(
    'SELECT id, verification_code, verification_code_expires_at, is_verified FROM users WHERE email = ?'
  ).bind(email).first<any>();

  if (!user) return c.json({ error: '用户不存在' }, 404);
  if (user.is_verified) return c.json({ error: '邮箱已验证' }, 400);
  if (user.verification_code !== code) return c.json({ error: '验证码错误' }, 400);
  if (new Date(user.verification_code_expires_at) < new Date()) {
    return c.json({ error: '验证码已过期' }, 400);
  }

  // 激活账号
  await c.env.DB.prepare(
    'UPDATE users SET is_verified = 1, email_verified_at = CURRENT_TIMESTAMP, verification_code = NULL, verification_code_expires_at = NULL WHERE id = ?'
  ).bind(user.id).run();

  // 邮箱验证成功 +5 积分
  const pointsService = new PointsService(c.env.DB);
  await pointsService.ensureUserPoints(user.id);
  await pointsService.addPoints(
    user.id,
    5,
    'system',
    '邮箱验证成功奖励'
  );

  // 给邀请人 +10 积分（如果有邀请记录）
  try {
    // 查找该用户对应的邀请记录（确认该用户是通过邀请注册的）
    const inviteRecord = await c.env.DB.prepare(
      `SELECT ir.invitation_id, i.user_id as inviter_id
       FROM invitation_records ir
       JOIN invitations i ON ir.invitation_id = i.id
       WHERE ir.invitee_id = ? AND ir.status = 'registered'
       ORDER BY ir.created_at ASC LIMIT 1`
    ).bind(user.id).first<{ invitation_id: number; inviter_id: number }>();

    if (inviteRecord) {
      // 检查邀请人是否已经获得过积分（防止重复奖励）
      const existingReward = await c.env.DB.prepare(
        `SELECT id FROM points_log 
         WHERE user_id = ? AND source_id = ? AND type = 'invite_register'`
      ).bind(inviteRecord.inviter_id, inviteRecord.invitation_id).first();

      if (!existingReward) {
        await pointsService.addPoints(
          inviteRecord.inviter_id,
          10,
          'invite_register',
          `邀请用户 ${email} 完成邮箱验证`,
          inviteRecord.invitation_id
        );
      }
    }
  } catch (err) {
    console.error('邀请人积分奖励失败:', err);
    // 不影响用户验证成功的结果
  }

  return c.json({ success: true, message: '邮箱验证成功，请登录' });
});

// ---------- 登录 ----------
app.post('/api/auth/login', zValidator('json', registerSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const user = await c.env.DB.prepare(
    'SELECT id, email, salt, password_hash, is_verified, nickname FROM users WHERE email = ?'
  ).bind(email).first<{ id: number; email: string; salt: string; password_hash: string; is_verified: number, nickname: string }>();

  if (!user) {
    return c.json({ error: '用户不存在！请先注册！' }, 401);
  }

  // 新增：检查邮箱是否已验证
  if (!user.is_verified) {
    return c.json({ error: '邮箱未验证，请先验证邮箱！', code: 'EMAIL_NOT_VERIFIED' }, 403);
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

  // 每日首次登录积分
  const service = new PointsService(c.env.DB);
  const today = new Date().toISOString().slice(0, 10);
  const hasToday = await c.env.DB.prepare(
    'SELECT id FROM points_log WHERE user_id = ? AND type = "daily_login" AND DATE(created_at) = ?'
  ).bind(user.id, today).first();

  if (!hasToday) {
    await service.addPoints(
      user.id,
      1,
      'daily_login',
      '每日登录奖励'
    );
  }

  // 返回 JSON 同时设置 HttpOnly Cookie
  return c.json(
    { user: { id: user.id, email: user.email, nickName: user.nickname || null } },
    {
      headers: {
        'Set-Cookie': `token=${token}; HttpOnly; Path=/; Max-Age=${expiresInMinutes * 60}; SameSite=None; Secure`,
      },
    }
  );
});

// ---------- 退出登录 ----------
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
app.post('/api/sentences/:id/media', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

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

app.get('/api/sentences/:id/media', async (c) => {
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
app.delete('/api/sentences/:id/media', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

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

// ---------- 用户资料 ----------
// 获取当前用户信息
app.get('/api/user/profile', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const user = await c.env.DB.prepare(
    'SELECT id, created_at FROM users WHERE id = ?'
  ).bind(auth.userId).first<{ id: number; email: string; nickname: string | null; created_at: string }>();
  if (!user) return c.json({ error: 'User not found' }, 404);

  return c.json(user);
});

// 更新昵称
app.put('/api/user/updateprofile', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);
  const { nickname } = await c.req.json();
  if (typeof nickname !== 'string' || nickname.trim().length === 0) {
    return c.json({ error: '昵称不能为空' }, 400);
  }
  // 后端校验示例
  if (Array.from(nickname).length > 20) {
    return c.json({ error: '昵称不能超过20个字符' }, 400);
  }
  await c.env.DB.prepare(
    'UPDATE users SET nickname = ? WHERE id = ?'
  ).bind(nickname.trim(), auth.userId).run();

  return c.json({ success: true, nickname: nickname.trim() });
});

// 修改密码
app.put('/api/user/password', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const { oldPassword, newPassword } = await c.req.json();
  if (!oldPassword || !newPassword || newPassword.length < 6) {
    return c.json({ error: '新密码长度至少为6位' }, 400);
  }

  // 获取当前用户盐和哈希
  const user = await c.env.DB.prepare(
    'SELECT salt, password_hash FROM users WHERE id = ?'
  ).bind(auth.userId).first<{ salt: string; password_hash: string }>();
  if (!user) return c.json({ error: 'User not found' }, 404);

  // 验证旧密码
  const isValid = await verifyPassword(oldPassword, user.salt, user.password_hash);
  if (!isValid) {
    return c.json({ error: '当前密码错误' }, 403);
  }

  // 生成新密码哈希
  const newSalt = generateSalt();
  const newHash = await hashPassword(newPassword, newSalt);

  await c.env.DB.prepare(
    'UPDATE users SET salt = ?, password_hash = ? WHERE id = ?'
  ).bind(newSalt, newHash, auth.userId).run();

  return c.json({ success: true });
});

// ---------- 检查邮箱状态 ----------
app.post('/api/auth/check-email', async (c) => {
  const { email } = await c.req.json();
  if (!email) return c.json({ error: '邮箱不能为空' }, 400);

  const user = await c.env.DB.prepare(
    'SELECT is_verified FROM users WHERE email = ?'
  ).bind(email).first<{ is_verified: number }>();

  if (!user) {
    return c.json({ exists: false, verified: false });
  }
  return c.json({ exists: true, verified: user.is_verified === 1 });
});

app.get('/api/invitations/my-link', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  let invite = await c.env.DB.prepare(
    'SELECT id, code, created_at FROM invitations WHERE user_id = ?'
  ).bind(auth.userId).first();

  // 如果没有，则创建
  if (!invite) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const code = generateInviteCode(auth.userId);
      await c.env.DB.prepare(
        'INSERT INTO invitations (user_id, code) VALUES (?, ?)'
      ).bind(auth.userId, code).run();

      invite = await c.env.DB.prepare(
        'SELECT id, code, created_at FROM invitations WHERE user_id = ?'
      ).bind(auth.userId).first();

      if (invite) {
        break;
      }
    }

    if (!invite) {
      throw new Error('生成邀请链接失败，请稍后重试！');
    }
  }

  return c.json({
    code: invite.code,
    link: `${c.env.FRONTEND_URL}/register?ref=${invite.code}`
  });
});

// 生成邀请码：用户ID + 时间戳 + 随机字符
function generateInviteCode(userId: number): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${userId}${timestamp.slice(-4)}${random}`;
}

// 获取邀请统计
app.get('/api/invitations/stats', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  // 获取总邀请数和注册数
  const invite = await c.env.DB.prepare(
    'SELECT total_invited, registered_count FROM invitations WHERE user_id = ?'
  ).bind(auth.userId).first();

  // 获取最近邀请记录
  const records = await c.env.DB.prepare(
    `SELECT invitee_email, status, created_at, registered_at 
     FROM invitation_records 
     WHERE invitation_id = (SELECT id FROM invitations WHERE user_id = ?)
     ORDER BY created_at DESC 
     LIMIT 20`
  ).bind(auth.userId).all();

  return c.json({
    total: invite?.total_invited || 0,
    registered: invite?.registered_count || 0,
    records: records.results || []
  });
});

app.post('/api/invitations/track-click', async (c) => {
  const { code } = await c.req.json();
  if (!code) return c.json({ error: 'Code required' }, 400);

  if (typeof code !== 'string') {
    console.log(typeof code);
    return c.json({ error: 'Invalid code format' }, 400);
  }

  // ✅ 获取真实 IP（Cloudflare 自动注入）
  const ip =
    c.req.header('CF-Connecting-IP') ||           // Cloudflare 真实 IP（生产环境）
    c.req.header('X-Forwarded-For')?.split(',')[0] || // 代理链 IP
    c.req.header('X-Real-IP') || 'unknown';           // 某些代理
  const userAgent = c.req.header('User-Agent') || 'unknown';

  const deviceType =
    c.req.header('CF-Device-Type') ||   // Cloudflare 提供的设备类型
    (c.req.header('User-Agent')?.includes('Mobile') ? 'mobile' : 'desktop') || // 简单降级
    'unknown';

  const invite = await c.env.DB.prepare(
    'SELECT id FROM invitations WHERE code = ?'
  ).bind(code).first<{ id: number }>();

  if (!invite) return c.json({ error: 'Invalid invite code' }, 404);

  // 检查同一 IP 是否已点击过该邀请
  const existing = await c.env.DB.prepare(
    `SELECT id FROM invitation_records 
   WHERE invitation_id = ? AND ip_address = ? AND status = 'accepted'`
  ).bind(invite.id, ip).first();

  if (existing) {
    return c.json({ success: true, message: '已记录过该 IP 的点击' });
    // return c.json({ error: '已记录过该 IP 的点击' }, 400);
  }

  // 插入一条 accepted 记录
  await c.env.DB.prepare(
    `INSERT INTO invitation_records 
     (invitation_id, status, ip_address, user_agent, device_type) 
     VALUES (?, 'accepted', ?, ?, ?)`
  ).bind(invite.id, ip, userAgent, deviceType).run();

  // 更新邀请统计
  await c.env.DB.prepare(
    `UPDATE invitations 
         SET total_invited = total_invited + 1, 
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
  ).bind(invite.id).run();

  return c.json({ success: true });
});

// ====== 积分服务 ======
interface PointsService {
  addPoints(userId: number, points: number, type: string, description: string, sourceId?: number): Promise<void>;
  getPoints(userId: number): Promise<{ total: number; level: string; levelIcon: string }>;
  getLogs(userId: number, limit?: number): Promise<any[]>;
}

class PointsService {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  // 添加积分
  async addPoints(userId: number, points: number, type: string, description: string, sourceId?: number): Promise<void> {
    // 确保用户有积分记录
    await this.ensureUserPoints(userId);

    // 更新总积分
    await this.db.prepare(
      'UPDATE user_points SET total_points = total_points + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'
    ).bind(points, userId).run();

    // 记录流水
    await this.db.prepare(
      `INSERT INTO points_log (user_id, points, type, source_id, description) 
       VALUES (?, ?, ?, ?, ?)`
    ).bind(userId, points, type, sourceId || null, description).run();

    // 更新等级
    await this.updateLevel(userId);
  }

  // 确保用户有积分记录
  async ensureUserPoints(userId: number): Promise<void> {
    const exists = await this.db.prepare(
      'SELECT id FROM user_points WHERE user_id = ?'
    ).bind(userId).first();

    if (!exists) {
      await this.db.prepare(
        'INSERT INTO user_points (user_id) VALUES (?)'
      ).bind(userId).run();
    }
  }

  // 获取用户积分和等级
  async getPoints(userId: number): Promise<{ total: number; level: string; levelIcon: string }> {
    await this.ensureUserPoints(userId);

    const result = await this.db.prepare(
      'SELECT total_points, level, level_icon FROM user_points WHERE user_id = ?'
    ).bind(userId).first<{ total_points: number; level: string; level_icon: string }>();

    return {
      total: result?.total_points || 0,
      level: result?.level || '青铜',
      levelIcon: result?.level_icon || '🥉',
    };
  }

  // 获取积分流水
  async getLogs(userId: number, limit: number = 50): Promise<any[]> {
    const logs = await this.db.prepare(
      `SELECT points, type, description, created_at 
       FROM points_log 
       WHERE user_id = ? 
       ORDER BY created_at DESC 
       LIMIT ?`
    ).bind(userId, limit).all();

    return logs.results || [];
  }

  // 更新等级
  async updateLevel(userId: number): Promise<void> {
    const points = await this.db.prepare(
      'SELECT total_points FROM user_points WHERE user_id = ?'
    ).bind(userId).first<{ total_points: number }>();

    if (!points) return;

    const total = points.total_points || 0;
    let level = '青铜';
    let icon = '🥉';

    if (total >= 500) { level = '传奇'; icon = '🏆'; }
    else if (total >= 200) { level = '钻石'; icon = '💎'; }
    else if (total >= 100) { level = '黄金'; icon = '🥇'; }
    else if (total >= 50) { level = '白银'; icon = '🥈'; }

    await this.db.prepare(
      'UPDATE user_points SET level = ?, level_icon = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'
    ).bind(level, icon, userId).run();
  }
}


// ====== 积分 API ======

// 获取我的积分
app.get('/api/points', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const service = new PointsService(c.env.DB);
  const points = await service.getPoints(auth.userId);
  return c.json(points);
});

// 获取积分流水
app.get('/api/points/log', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const limit = Number(c.req.query('limit')) || 50;
  const service = new PointsService(c.env.DB);
  const logs = await service.getLogs(auth.userId, limit);
  return c.json(logs);
});

// 积分排行榜（可选）
app.get('/api/points/rank', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const rank = await c.env.DB.prepare(
    `SELECT u.nickname, u.email, p.total_points, p.level, p.level_icon
     FROM user_points p
     JOIN users u ON p.user_id = u.id
     ORDER BY p.total_points DESC
     LIMIT 20`
  ).all();

  return c.json(rank.results || []);
});
export default app;

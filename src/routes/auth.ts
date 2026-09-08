import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { PointsService } from '../services/PointsService';
import { z } from 'zod';
import { generateSalt, hashPassword, verifyPassword, signJWT } from '../utils/auth';
import { Resend } from 'resend';

import { authBindings } from '../types/bindings';

export const authRoutes = new Hono<{ Bindings: authBindings }>();
// ---------- 注册（类似 @PostMapping("/register")） ----------
const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
});
// const registerSchema = z.object({
//   email: z.string().email({ message: '邮箱格式不正确!' }),
//   password: z.string().min(6, { message: '密码长度至少为 6 个字符' }),
// });
authRoutes.post('/register', zValidator('json', registerSchema), async (c) => {
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

        if (refCode) {
            const invite = await c.env.DB.prepare(
                'SELECT id, user_id FROM invitations WHERE code = ?'
            ).bind(refCode).first<{ id: number; user_id: number }>();

            const ip =
                c.req.header('CF-Connecting-IP') ||           // Cloudflare 真实 IP（生产环境）
                c.req.header('X-Forwarded-For')?.split(',')[0] || // 代理链 IP
                c.req.header('X-Real-IP') || 'unknown';           // 某些代理

            if (invite) {
                // 更新 invitation_records：关联新用户
                await c.env.DB.prepare(
                    `UPDATE invitation_records 
           SET invitee_id = ?, invitee_email = ?, status = 'registered', registered_at = CURRENT_TIMESTAMP
           WHERE invitation_id = ? AND status = 'accepted' AND ip_address = ?
           ORDER BY created_at ASC LIMIT 1`
                ).bind(result.id, email, invite.id, ip).run();

                // 更新邀请统计
                await c.env.DB.prepare(
                    `UPDATE invitations 
         SET registered_count = registered_count + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
                ).bind(invite.id).run();
            }
        }

        return c.json({
            success: true,
            message: '注册成功，请验证邮箱',
            email: email
        }, 201);
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
authRoutes.post('/login', zValidator('json', registerSchema), async (c) => {
    const { email, password } = c.req.valid('json');
    const user = await c.env.DB.prepare(
        'SELECT id, email, salt, password_hash, is_verified, nickname FROM users WHERE email = ?'
    ).bind(email).first<{ id: number; email: string; salt: string; password_hash: string; is_verified: number, nickname: string }>();

    if (!user) {
        return c.json({ error: '用户不存在！请先注册！' }, 401);
    }

    // // 新增：检查邮箱是否已验证
    // if (!user.is_verified) {
    //   return c.json({ error: '邮箱未验证，请先验证邮箱！', code: 'EMAIL_NOT_VERIFIED' }, 403);
    // }

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
        {
            user: {
                id: user.id,
                email: user.email,
                nickname: user.nickname || null,
                is_verified: user.is_verified === 1,  // ✅ 返回验证状态
            }
        },
        {
            headers: {
                'Set-Cookie': `token=${token}; HttpOnly; Path=/; Max-Age=${expiresInMinutes * 60}; SameSite=None; Secure`,
            },
        }
    );
});

// ---------- 检查邮箱状态 ----------
authRoutes.post('/check-email', async (c) => {
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


// ---------- 发送验证码 ----------
authRoutes.post('/send-verification', async (c) => {
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
authRoutes.post('/verify-email', async (c) => {
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


// ---------- 退出登录 ----------
authRoutes.post('/logout', async (c) => {
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
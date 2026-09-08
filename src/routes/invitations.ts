import { authenticate } from '../utils/auth';
import { Hono } from 'hono';
import{ generateInviteCode}from'../utils/code';
import { inviteBindings } from '../types/bindings';
import { requireVerified } from '../utils/verify';

export const invitationRoutes = new Hono<{ Bindings: inviteBindings }>();

invitationRoutes.get('/my-link', async (c) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  // ✅ 检查是否已验证
  const result = await requireVerified(c.env.DB, auth.userId);
  if (!result.verified) {
    return c.json({ error: '请先验证邮箱再尝试邀请！', code: 'EMAIL_NOT_VERIFIED' }, 403);
  }

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

invitationRoutes.post('/track-click', async (c) => {
  const { code } = await c.req.json();
  if (!code) return c.json({ error: 'Code required' }, 400);

  if (typeof code !== 'string') {
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

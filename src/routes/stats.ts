import { authenticate } from '../utils/auth';
import { Hono } from 'hono';

import { Bindings } from '../types/bindings';
export const statsRoutes = new Hono<{ Bindings: Bindings }>();

// 可选：统计接口（Dashboard 用）
statsRoutes.get('/home', async (c) => {
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

// 获取邀请统计
statsRoutes.get('/invitations', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    // 获取总邀请数和注册数
    const invite = await c.env.DB.prepare(
        'SELECT total_invited, registered_count FROM invitations WHERE user_id = ?'
    ).bind(auth.userId).first();

    // 获取最近邀请记录
    const records = await c.env.DB.prepare(
        `SELECT 
       ir.id,
       ir.invitee_email,
       ir.status,
       ir.created_at,
       ir.registered_at,
       ir.ip_address,
       ir.device_type,
       u.is_verified AS invitee_verified
     FROM invitation_records ir
     LEFT JOIN users u ON ir.invitee_id = u.id
     WHERE ir.invitation_id = (SELECT id FROM invitations WHERE user_id = ?)
     ORDER BY ir.created_at DESC
     LIMIT 50`
    ).bind(auth.userId).all();

    // 统计已认证数量（被邀请用户中已验证邮箱的）
    const verifiedResult = await c.env.DB.prepare(
        `SELECT COUNT(*) as count
     FROM invitation_records ir
     JOIN invitations i ON ir.invitation_id = i.id
     JOIN users u ON ir.invitee_id = u.id
     WHERE i.user_id = ? AND ir.status = 'registered' AND u.is_verified = 1`
    ).bind(auth.userId).first<{ count: number }>();

    return c.json({
        total: invite?.total_invited || 0,
        registered: invite?.registered_count || 0,
        verified: verifiedResult?.count || 0,
        records: records.results || []
    });
});
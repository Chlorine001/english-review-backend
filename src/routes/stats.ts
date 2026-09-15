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
// backend/src/routes/stats.ts 或 index.ts

statsRoutes.get('/progress', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    // 1. 各状态数量
    const statusCounts = await c.env.DB.prepare(
        `SELECT status, COUNT(*) as count 
     FROM reviews 
     WHERE user_id = ? 
     GROUP BY status`
    ).bind(auth.userId).all();

    // 2. 总数
    const total = await c.env.DB.prepare(
        'SELECT COUNT(*) as count FROM sentences WHERE user_id = ?'
    ).bind(auth.userId).first<{ count: number }>();

    // 3. 今日待复习 / 已完成
    const now = new Date().toISOString();
    const todayPending = await c.env.DB.prepare(
        `SELECT COUNT(*) as count FROM reviews 
     WHERE user_id = ? AND next_review_at <= ? AND status != 'MATURE'`
    ).bind(auth.userId, now).first<{ count: number }>();

    // 今日已完成（今天有复习记录的）
    const todayDone = await c.env.DB.prepare(
        `SELECT COUNT(*) as count FROM reviews 
     WHERE user_id = ? AND DATE(last_review_at) = DATE('now')`
    ).bind(auth.userId).first<{ count: number }>();

    // 4. 连续学习天数（Streak）
    const streak = await c.env.DB.prepare(
        `SELECT COUNT(DISTINCT DATE(created_at)) as days 
     FROM points_log 
     WHERE user_id = ? AND type = 'daily_login' 
     AND created_at >= datetime('now', '-30 days')`
    ).bind(auth.userId).first<{ days: number }>();

    // 5. 组装结果
    const statusMap: Record<string, number> = {
        NEW: 0,
        LEARNING: 0,
        REVIEW: 0,
        MATURE: 0,
    };

    (statusCounts.results || []).forEach((row: any) => {
        statusMap[row.status] = row.count;
    });

    return c.json({
        total: total?.count || 0,
        byStatus: statusMap,
        todayPending: todayPending?.count || 0,
        todayDone: todayDone?.count || 0,
        streak: streak?.days || 0,
    });
});
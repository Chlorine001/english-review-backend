// backend/src/routes/points.ts
import { Hono } from 'hono';
import { authenticate } from '../utils/auth';
import { PointsService } from '../services/PointsService';

import { Bindings } from '../types/bindings';

const pointsRoutes = new Hono<{ Bindings: Bindings }>();

// 获取我的积分
pointsRoutes.get('/', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const service = new PointsService(c.env.DB);
    const points = await service.getPoints(auth.userId);
    return c.json(points);
});

// 获取积分流水
pointsRoutes.get('/log', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const limit = Number(c.req.query('limit')) || 50;
    const service = new PointsService(c.env.DB);
    const logs = await service.getLogs(auth.userId, limit);
    return c.json(logs);
});

// 积分排行榜
pointsRoutes.get('/rank', async (c) => {
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

export { pointsRoutes };
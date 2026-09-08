import { authenticate } from '../utils/auth';
import { Hono } from 'hono';

import { Bindings } from '../types/bindings';
export const reviewRoutes = new Hono<{ Bindings: Bindings }>();

// ---------- 获取今日复习队列 ----------
reviewRoutes.get('/today', async (c) => {
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
reviewRoutes.post('/:id/answer', async (c) => {
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
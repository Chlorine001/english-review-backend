import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { Bindings } from './types/bindings';
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

import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/user';
import { sentenceRoutes } from './routes/sentences';
import { reviewRoutes } from './routes/reviews';
import { invitationRoutes } from './routes/invitations';
import { pointsRoutes } from './routes/points';
import { statsRoutes } from './routes/stats';

// 注册路由
app.route('/api/auth', authRoutes);
app.route('/api/user', userRoutes);
app.route('/api/sentences', sentenceRoutes);
app.route('/api/reviews', reviewRoutes);
app.route('/api/invitations', invitationRoutes);
app.route('/api/points', pointsRoutes);
app.route('/api/stats', statsRoutes);

export default app;

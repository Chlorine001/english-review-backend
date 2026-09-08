import { authenticate } from '../utils/auth';
import { Hono } from 'hono';
import { generateSalt, hashPassword, verifyPassword} from '../utils/auth';

import { Bindings } from '../types/bindings';
export const userRoutes = new Hono<{ Bindings: Bindings }>();

// ---------- 用户资料 ----------
// 获取当前用户信息
userRoutes.get('/profile', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const user = await c.env.DB.prepare(
        'SELECT id, created_at FROM users WHERE id = ?'
    ).bind(auth.userId).first<{ id: number; email: string; nickname: string | null; created_at: string }>();
    if (!user) return c.json({ error: 'User not found' }, 404);

    return c.json(user);
});

// 更新昵称
userRoutes.put('/updateprofile', async (c) => {
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
userRoutes.put('/password', async (c) => {
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


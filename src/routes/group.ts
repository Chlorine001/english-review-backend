import { authenticate } from '../utils/auth';
import { Hono } from 'hono';
import { generateGroupCode } from '../utils/code';
import { Bindings } from '../types/bindings';
export const groupRoutes = new Hono<{ Bindings: Bindings }>();

groupRoutes.post('/', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const { name, description, isPublic } = await c.req.json();
    if (!name || name.length < 2) {
        return c.json({ error: '小组名称至少2个字符' }, 400);
    }

    // 生成邀请码
    const inviteCode = generateGroupCode();

    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
        // 创建小组
        result = await c.env.DB.prepare(
            `INSERT INTO groups (name, description, owner_id, invite_code, is_public) VALUES (?, ?, ?, ?, ?) RETURNING id`
        ).bind(name, description || '', auth.userId, inviteCode, isPublic !== false ? 1 : 0).first<{ id: number }>();
        if (result) {
            break;
        }
    }

    if (!result) {
        throw new Error('创建小组失败，请稍后重试！');
    }

    // 添加创建者为成员
    await c.env.DB.prepare(
        `INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'owner')`
    ).bind(result.id, auth.userId).run();

    return c.json({ id: result.id, inviteCode });
});


groupRoutes.get('/mine', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const groups = await c.env.DB.prepare(
        `SELECT g.*, gm.role, 
     (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
     FROM groups g
     JOIN group_members gm ON g.id = gm.group_id
     WHERE gm.user_id = ?
     ORDER BY g.created_at DESC`
    ).bind(auth.userId).all();

    return c.json(groups.results || []);
});

groupRoutes.post('/join', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const { inviteCode } = await c.req.json();
    if (!inviteCode) return c.json({ error: '邀请码不能为空' }, 400);

    // 查找小组
    const group = await c.env.DB.prepare(
        'SELECT id, member_count, max_members FROM groups WHERE invite_code = ?'
    ).bind(inviteCode).first<{ id: number; member_count: number; max_members: number }>();

    if (!group) return c.json({ error: '小组不存在' }, 404);
    if (group.member_count >= group.max_members) {
        return c.json({ error: '小组已满' }, 400);
    }

    // 检查是否已加入
    const existing = await c.env.DB.prepare(
        'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?'
    ).bind(group.id, auth.userId).first();

    if (existing) return c.json({ error: '已加入该小组' }, 400);

    // 添加成员
    await c.env.DB.prepare(
        `INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')`
    ).bind(group.id, auth.userId).run();

    // 更新成员数
    await c.env.DB.prepare(
        'UPDATE groups SET member_count = member_count + 1 WHERE id = ?'
    ).bind(group.id).run();

    // 记录动态
    await c.env.DB.prepare(
        `INSERT INTO group_activities (group_id, user_id, type) VALUES (?, ?, 'join')`
    ).bind(group.id, auth.userId).run();

    return c.json({ success: true, groupId: group.id });
});

groupRoutes.get('/api/groups/:id', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const id = Number(c.req.param('id'));

    // 1. 获取小组信息
    const group = await c.env.DB.prepare(
        `SELECT g.*, u.nickname as owner_name
     FROM groups g
     JOIN users u ON g.owner_id = u.id
     WHERE g.id = ?`
    ).bind(id).first();

    if (!group) return c.json({ error: '小组不存在' }, 404);

    // 2. 检查当前用户是否为创建者
    const isOwner = group.owner_id === auth.userId;

    // 3. 检查当前用户是否为成员
    const member = await c.env.DB.prepare(
        'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?'
    ).bind(id, auth.userId).first();
    const isMember = !!member;

    // 4. 获取成员列表（包含角色信息）
    const members = await c.env.DB.prepare(
        `SELECT u.id, u.email, u.nickname, gm.role, gm.joined_at
     FROM group_members gm
     JOIN users u ON gm.user_id = u.id
     WHERE gm.group_id = ?
     ORDER BY gm.role = 'owner' DESC, gm.joined_at ASC`
    ).bind(id).all();

    // 5. 返回完整数据
    return c.json({
        ...group,
        isOwner,
        isMember,
        members: members.results || [],
    });
});
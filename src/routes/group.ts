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
    let group;
    for (let attempt = 1; attempt <= 3; attempt++) {
        // 创建小组
        group = await c.env.DB.prepare(
            `INSERT INTO groups (name, description, owner_id, invite_code, is_public) VALUES (?, ?, ?, ?, ?) RETURNING id`
        ).bind(name, description || '', auth.userId, inviteCode, isPublic !== false ? 1 : 0).first<{ id: number }>();
        if (group) {
            break;
        }
    }
    if (!group) {
        throw new Error('创建小组失败，请稍后重试！');
    }
    recordMember(c.env.DB, group.id, auth.userId, 'owner')

    recordActivity(c.env.DB, group.id, auth.userId, 'create', `创建了小组！`);

    return c.json({ id: group.id, inviteCode });
});

groupRoutes.get('/open', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const groups = await c.env.DB.prepare(
        `SELECT 
       g.*,
       (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count,
       EXISTS(
         SELECT 1 FROM group_members 
         WHERE group_id = g.id AND user_id = ?
       ) as is_member
     FROM groups g
     WHERE g.is_public = 1
     ORDER BY 
       is_member ASC,       -- 未加入的排前面（0 在前，1 在后）
       g.created_at DESC    -- 同组内按创建时间倒序
     LIMIT 50`
    ).bind(auth.userId).all();

    return c.json(groups.results || []);
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

    recordMember(c.env.DB, group.id, auth.userId, 'member')
    // 记录动态
    recordActivity(c.env.DB, group.id, auth.userId, 'join', `通过邀请码加入了小组！`);

    return c.json({ success: true, groupId: group.id });
});

// 直接加入公开小组
groupRoutes.post('/:id/join', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const groupId = Number(c.req.param('id'));
    if (isNaN(groupId)) return c.json({ error: 'Invalid group id' }, 400);

    // 1. 查小组
    const group = await c.env.DB.prepare(
        'SELECT id, is_public, member_count, max_members FROM groups WHERE id = ?'
    ).bind(groupId).first<{ id: number; is_public: number; member_count: number; max_members: number }>();

    if (!group) return c.json({ error: '小组不存在' }, 404);
    if (!group.is_public) return c.json({ error: '该小组需要邀请码才能加入' }, 403);
    if (group.member_count >= group.max_members) {
        return c.json({ error: '小组已满' }, 400);
    }

    // 2. 检查是否已加入
    const existing = await c.env.DB.prepare(
        'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?'
    ).bind(groupId, auth.userId).first();

    if (existing) return c.json({ error: '已加入该小组' }, 400);

    // 3. 加入
    await c.env.DB.prepare(
        `INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')`
    ).bind(groupId, auth.userId).run();

    await c.env.DB.prepare(
        'UPDATE groups SET member_count = member_count + 1 WHERE id = ?'
    ).bind(groupId).run();

    // 4. 记录动态
    await recordActivity(c.env.DB, groupId, auth.userId, 'join', '加入了小组！');

    return c.json({ success: true, groupId });
});

groupRoutes.get('/:id', async (c) => {
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

    // 2. 检查当前用户角色
    const member = await c.env.DB.prepare(
        'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?'
    ).bind(id, auth.userId).first<{ role: string }>();
    const isMember = !!member;
    const isAdmin = member?.role === 'admin';

    // 3. 检查当前用户是否为组长
    const isOwner = group.owner_id === auth.userId;

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
        isAdmin,
        isMember,
        members: members.results || [],
    });
});

groupRoutes.get('/:id/activities', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const groupId = Number(c.req.param('id'));

    const activities = await c.env.DB.prepare(
        `SELECT
       ga.id,
       ga.type,
       ga.content,
       ga.created_at,
       ga.target_user_id,
       COALESCE(u.nickname, u.email) as user_nickname,
       COALESCE(t.nickname, t.email) as target_user_nickname
     FROM group_activities ga
     JOIN users u ON ga.user_id = u.id
     LEFT JOIN users t ON ga.target_user_id = t.id
     WHERE ga.group_id = ?
     ORDER BY ga.created_at DESC
     LIMIT 50`
    ).bind(groupId).all();

    return c.json(activities.results || []);
});

// 转让小组接口
groupRoutes.post('/:id/transfer', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const groupId = Number(c.req.param('id'));
    try {
        // ✅ 正确获取 body
        const { newOwnerId } = await c.req.json();
        if (!newOwnerId) return c.json({ error: '请选择新组长' }, 400);

        // 1. 获取小组
        const group = await c.env.DB.prepare(
            'SELECT owner_id FROM groups WHERE id = ?'
        ).bind(groupId).first<{ owner_id: number }>();
        if (!group) return c.json({ error: '小组不存在' }, 404);

        // 2. ✅ 验证当前用户是组长
        if (group.owner_id !== auth.userId) {
            return c.json({ error: '只有组长可以转让' }, 403);
        }

        // 3. ✅ 验证新组长是小组的成员
        const newOwner = await c.env.DB.prepare(
            'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?'
        ).bind(groupId, newOwnerId).first();
        if (!newOwner) {
            return c.json({ error: '目标用户不是小组成员' }, 400);
        }

        // 4. ✅ 不能转让给自己
        if (newOwnerId === auth.userId) {
            return c.json({ error: '不能转让给自己' }, 400);
        }

        transferOwnership(c.env.DB, groupId, auth.userId, Number(newOwnerId));
        return c.json({ success: true });
    } catch (err: any) {
        console.error('转让失败:', err);
        return c.json({ error: err.message || '转让失败' }, 500);  // ✅ 捕获异常并返回
    }
});

// 转让小组逻辑
async function transferOwnership(db: D1Database, groupId: number, oldOwnerId: number, newOwnerId: number) {
    // 1. 更新 groups 表的 owner_id
    await db.prepare(
        'UPDATE groups SET owner_id = ? WHERE id = ?'
    ).bind(newOwnerId, groupId).run();

    // 2. 更新成员角色
    await db.prepare(
        "UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?"
    ).bind(groupId, oldOwnerId).run();

    await db.prepare(
        "UPDATE group_members SET role = 'owner' WHERE group_id = ? AND user_id = ?"
    ).bind(groupId, newOwnerId).run();

    // 3. 记录动态
    recordActivity(db, groupId, newOwnerId, 'transfer', `转让了小组给`, oldOwnerId);

}

// 移除成员
groupRoutes.post('/:id/kick', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const groupId = Number(c.req.param('id'));

    try {
        const { userId } = await c.req.json();
        if (!userId) return c.json({ error: '请选择要移除的成员' }, 400);

        // 1. 查小组
        const group = await c.env.DB.prepare(
            'SELECT owner_id FROM groups WHERE id = ?'
        ).bind(groupId).first<{ owner_id: number }>();

        if (!group) return c.json({ error: '小组不存在' }, 404);

        // 2. 检查操作权限：组长 or 管理员
        const operator = await c.env.DB.prepare(
            'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?'
        ).bind(groupId, auth.userId).first<{ role: string }>();

        const isOwner = group.owner_id === auth.userId;
        const isAdmin = operator?.role === 'admin';

        if (!isOwner && !isAdmin) {
            return c.json({ error: '没有权限移除成员' }, 403);
        }

        // 3. 不能移除组长
        if (userId === group.owner_id) {
            return c.json({ error: '不能移除组长' }, 400);
        }

        // 4. 管理员不能移除其他管理员
        const target = await c.env.DB.prepare(
            'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?'
        ).bind(groupId, userId).first<{ role: string }>();

        if (!target) return c.json({ error: '目标用户不是小组成员' }, 400);
        if (target.role === 'admin' && !isOwner) {
            return c.json({ error: '管理员不能移除其他管理员' }, 403);
        }

        // 5. 移除成员
        await c.env.DB.prepare(
            'DELETE FROM group_members WHERE group_id = ? AND user_id = ?'
        ).bind(groupId, userId).run();

        await c.env.DB.prepare(
            'UPDATE groups SET member_count = member_count - 1 WHERE id = ?'
        ).bind(groupId).run();

        await recordActivity(
            c.env.DB,
            groupId,
            auth.userId,
            'kick',
            '移除了成员',
            userId
        );

        return c.json({ success: true });
    } catch (err: any) {
        console.error('移除成员失败:', err);
        return c.json({ error: err.message || '移除失败' }, 500);
    }
});

// 退出小组
groupRoutes.post('/:id/leave', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const groupId = Number(c.req.param('id'));

    // 1. 查小组
    const group = await c.env.DB.prepare(
        'SELECT owner_id FROM groups WHERE id = ?'
    ).bind(groupId).first<{ owner_id: number }>();

    if (!group) return c.json({ error: '小组不存在' }, 404);

    // 2. 组长不能退出（必须先转让或解散）
    if (group.owner_id === auth.userId) {
        return c.json({ error: '组长不能退出小组，请先转让组长或解散小组' }, 400);
    }

    // 3. 检查是否为成员
    const member = await c.env.DB.prepare(
        'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?'
    ).bind(groupId, auth.userId).first();

    if (!member) return c.json({ error: '你不是该小组成员' }, 400);

    // 4. 删除成员记录
    await c.env.DB.prepare(
        'DELETE FROM group_members WHERE group_id = ? AND user_id = ?'
    ).bind(groupId, auth.userId).run();

    // 5. 更新成员数
    await c.env.DB.prepare(
        'UPDATE groups SET member_count = member_count - 1 WHERE id = ?'
    ).bind(groupId).run();

    // 6. 记录动态
    await recordActivity(c.env.DB, groupId, auth.userId, 'leave', '退出了小组');

    return c.json({ success: true });
});

// 设置/取消管理员
groupRoutes.post('/:id/set-admin', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const groupId = Number(c.req.param('id'));

    try {
        const { userId, isAdmin } = await c.req.json();
        if (!userId) return c.json({ error: '请选择成员' }, 400);

        // 1. 查小组
        const group = await c.env.DB.prepare(
            'SELECT owner_id FROM groups WHERE id = ?'
        ).bind(groupId).first<{ owner_id: number }>();

        if (!group) return c.json({ error: '小组不存在' }, 404);

        // 2. 只有组长可以设置管理员
        if (group.owner_id !== auth.userId) {
            return c.json({ error: '只有组长可以设置管理员' }, 403);
        }

        // 3. 不能设置组长自己
        if (userId === group.owner_id) {
            return c.json({ error: '组长不能设置为管理员' }, 400);
        }

        // 4. 检查目标用户是成员
        const target = await c.env.DB.prepare(
            'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?'
        ).bind(groupId, userId).first<{ role: string }>();

        if (!target) return c.json({ error: '目标用户不是小组成员' }, 400);

        // 5. 更新角色
        const newRole = isAdmin ? 'admin' : 'member';
        await c.env.DB.prepare(
            'UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?'
        ).bind(newRole, groupId, userId).run();

        // 6. 记录动态
        await recordActivity(
            c.env.DB,
            groupId,
            auth.userId,
            'set_admin',
            isAdmin ? '设置' : '取消' + '了管理员',
            userId,
        );

        return c.json({ success: true, role: newRole });
    } catch (err: any) {
        console.error('设置管理员失败:', err);
        return c.json({ error: err.message || '设置失败' }, 500);
    }
});

groupRoutes.delete('/:id', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const id = Number(c.req.param('id'));

    // 验证是否为组长
    const group = await c.env.DB.prepare(
        'SELECT owner_id FROM groups WHERE id = ?'
    ).bind(id).first<{ owner_id: number }>();

    if (!group) return c.json({ error: '小组不存在' }, 404);
    if (group.owner_id !== auth.userId) {
        return c.json({ error: '只有组长可以解散小组' }, 403);
    }

    // 级联删除（依赖外键 ON DELETE CASCADE）
    await c.env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(id).run();

    return c.json({ success: true });
});

// 更新小组信息
groupRoutes.put('/:id', async (c) => {
    const auth = await authenticate(c.req.raw, c.env);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const id = Number(c.req.param('id'));
    const { name, description, isPublic } = await c.req.json();

    // 验证是否为组长
    const group = await c.env.DB.prepare(
        'SELECT owner_id FROM groups WHERE id = ?'
    ).bind(id).first<{ owner_id: number }>();

    if (!group) return c.json({ error: '小组不存在' }, 404);
    if (group.owner_id !== auth.userId) {
        return c.json({ error: '只有组长可以修改小组信息' }, 403);
    }

    // 动态拼接更新字段
    const updates: string[] = [];
    const params: any[] = [];

    if (name !== undefined) {
        if (name.length < 2) return c.json({ error: '小组名称至少2个字符' }, 400);
        updates.push('name = ?');
        params.push(name.trim());
    }
    if (description !== undefined) {
        updates.push('description = ?');
        params.push(description.trim());
    }
    if (isPublic !== undefined) {
        updates.push('is_public = ?');
        params.push(isPublic ? 1 : 0);
    }

    if (updates.length === 0) {
        return c.json({ error: '没有需要更新的字段' }, 400);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    await c.env.DB.prepare(
        `UPDATE groups SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...params).run();

    return c.json({ success: true });
});

// 加入小组时记录动态
async function recordActivity(
    db: D1Database,
    groupId: number,
    userId: number,        // 操作人
    type: string,
    content: string,        // 动作描述，如 "加入了小组"
    targetUserId?: number  // ✅ 被操作人（可选）
) {
    // type     图标	 触发时机    内容示例
    // create	✨      创建小组    "Admin 创建了小组"
    // join	    👋      加入小组  	"Dragon 加入了小组"
    // share	📤      分享句子	"Dragon 分享了一个句子：..."
    // like	    ❤️      点赞句子   	"Alice 点赞了 Dragon 的句子"
    // review	📚      完成复习    "Dragon 完成了今日复习（5 个）"
    // leave	🚪     
    // transfer	👑      转让小组    "Alice 转让了小组给 Bob"
    //  退出小组  	"Bob 退出了小组"
    await db.prepare(
        `INSERT INTO group_activities (group_id, user_id, type, content, target_user_id) 
     VALUES (?, ?, ?, ?, ?)`
    ).bind(groupId, userId, type, content, targetUserId || null).run();
}

// 更新小组成员
async function recordMember(db: D1Database, groupId: number, userId: number, type: string) {
    // 添加成员
    await db.prepare(
        `INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)`
    ).bind(groupId, userId, type).run();
    if (type != 'owner') {
        // 更新成员数
        await db.prepare(
            'UPDATE groups SET member_count = member_count + 1 WHERE id = ?'
        ).bind(groupId).run();

    }

}
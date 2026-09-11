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
    recordActivity(c.env.DB, group.id, auth.userId, 'join', `加入了小组！`);

    return c.json({ success: true, groupId: group.id });
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

// 加入小组时记录动态
async function recordActivity(db: D1Database, groupId: number, userId: number, type: string, content: string) {
    // type     图标	 触发时机    内容示例
    // create	✨      创建小组    "Admin 创建了小组"
    // join	    👋      加入小组  	"Dragon 加入了小组"
    // share	📤      分享句子	"Dragon 分享了一个句子：..."
    // like	    ❤️      点赞句子   	"Alice 点赞了 Dragon 的句子"
    // review	📚      完成复习    "Dragon 完成了今日复习（5 个）"
    // leave	🚪     
    //  退出小组  	"Bob 退出了小组"
    await db.prepare(
        `INSERT INTO group_activities (group_id, user_id, type, content) 
     VALUES (?, ?, ?, ?)`
    ).bind(groupId, userId, type, content).run();
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
            COALESCE(u.nickname, u.email) as user_nickname
        FROM group_activities ga
        JOIN users u ON ga.user_id = u.id
        WHERE ga.group_id = ?
        ORDER BY ga.created_at DESC
        LIMIT 50`
    ).bind(groupId).all();

    return c.json(activities.results || []);
});


//todo 转让群主逻辑
// async function transferOwnership(db: D1Database, groupId: number, oldOwnerId: number, newOwnerId: number) {
//     // 1. 更新 groups 表的 owner_id
//     await db.prepare(
//         'UPDATE groups SET owner_id = ? WHERE id = ?'
//     ).bind(newOwnerId, groupId).run();

//     // 2. 更新成员角色
//     await db.prepare(
//         "UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?"
//     ).bind(groupId, oldOwnerId).run();

//     await db.prepare(
//         "UPDATE group_members SET role = 'owner' WHERE group_id = ? AND user_id = ?"
//     ).bind(groupId, newOwnerId).run();

//     // 3. 查昵称
//     const oldUser = await db.prepare('SELECT nickname FROM users WHERE id = ?').bind(oldOwnerId).first<any>();
//     const newUser = await db.prepare('SELECT nickname FROM users WHERE id = ?').bind(newOwnerId).first<any>();
//     const oldName = oldUser?.nickname || '用户';
//     const newName = newUser?.nickname || '用户';

//     // 4. 记录动态
//     await db.prepare(
//         `INSERT INTO group_activities (group_id, user_id, type, content) 
//      VALUES (?, ?, 'owner', ?)`
//     ).bind(groupId, oldOwnerId, `${oldName} 将群主转让给 ${newName}`).run();
// }

//todo 移除成员
// await db.prepare(
//     `INSERT INTO group_activities (group_id, user_id, type, content)
//    VALUES (?, ?, 'kick', ?)`
// ).bind(groupId, auth.userId, `${adminName} 移除了 ${removedName}`).run();
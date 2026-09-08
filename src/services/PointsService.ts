// ====== 积分服务 ======
export class PointsService {
    private db: D1Database;

    constructor(db: D1Database) {
        this.db = db;
    }

    // 添加积分
    async addPoints(userId: number, points: number, type: string, description: string, sourceId?: number): Promise<void> {
        // 确保用户有积分记录
        await this.ensureUserPoints(userId);
        await this.db.prepare(
            'UPDATE user_points SET total_points = total_points + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'
        ).bind(points, userId).run();

        // 记录流水
        await this.db.prepare(
            `INSERT INTO points_log (user_id, points, type, source_id, description) 
       VALUES (?, ?, ?, ?, ?)`
        ).bind(userId, points, type, sourceId || null, description).run();

        // 更新等级
        await this.updateLevel(userId);
    }

    // 确保用户有积分记录
    async ensureUserPoints(userId: number): Promise<void> {
        const exists = await this.db.prepare(
            'SELECT id FROM user_points WHERE user_id = ?'
        ).bind(userId).first();

        if (!exists) {
            await this.db.prepare(
                'INSERT INTO user_points (user_id) VALUES (?)'
            ).bind(userId).run();
        }
    }
    
    // 获取用户积分和等级
    async getPoints(userId: number): Promise<{ total: number; level: string; levelIcon: string }> {
        await this.ensureUserPoints(userId);

        const result = await this.db.prepare(
            'SELECT total_points, level, level_icon FROM user_points WHERE user_id = ?'
        ).bind(userId).first<{ total_points: number; level: string; level_icon: string }>();

        return {
            total: result?.total_points || 0,
            level: result?.level || '青铜',
            levelIcon: result?.level_icon || '🥉',
        };
    }

    // 获取积分流水
    async getLogs(userId: number, limit: number = 50): Promise<any[]> {
        const logs = await this.db.prepare(
            `SELECT points, type, description, created_at 
       FROM points_log 
       WHERE user_id = ? 
       ORDER BY created_at DESC 
       LIMIT ?`
        ).bind(userId, limit).all();

        return logs.results || [];
    }

    // 更新等级
    async updateLevel(userId: number): Promise<void> {
        const points = await this.db.prepare(
            'SELECT total_points FROM user_points WHERE user_id = ?'
        ).bind(userId).first<{ total_points: number }>();

        if (!points) return;

        const total = points.total_points || 0;
        let level = '青铜';
        let icon = '🥉';

        if (total >= 500) { level = '传奇'; icon = '🏆'; }
        else if (total >= 200) { level = '钻石'; icon = '💎'; }
        else if (total >= 100) { level = '黄金'; icon = '🥇'; }
        else if (total >= 50) { level = '白银'; icon = '🥈'; }

        await this.db.prepare(
            'UPDATE user_points SET level = ?, level_icon = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'
        ).bind(level, icon, userId).run();
    }
}
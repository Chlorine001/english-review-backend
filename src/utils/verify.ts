// 验证用户是否已认证（用于需要验证的功能）
// ====== 验证工具函数 ======
export async function requireVerified(db: D1Database, userId: number): Promise<{ verified: boolean; user?: any }> {
    const user = await db.prepare(
        'SELECT id, email, is_verified, nickname FROM users WHERE id = ?'
    ).bind(userId).first<{ id: number; email: string; is_verified: number; nickname: string | null }>();

    if (!user) return { verified: false };
    return { verified: user.is_verified === 1, user:user };
}
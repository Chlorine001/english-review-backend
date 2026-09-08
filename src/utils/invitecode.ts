// 生成邀请码：用户ID + 时间戳 + 随机字符
export function generateInviteCode(userId: number): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${userId}${timestamp.slice(-4)}${random}`;
}
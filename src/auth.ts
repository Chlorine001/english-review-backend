// src/auth.ts
const encoder = new TextEncoder();

// Base64URL 工具函数
function base64UrlEncode(data: string | Uint8Array): string {
  let base64: string;
  if (typeof data === 'string') {
    base64 = btoa(data);
  } else {
    // 注意：如果数据量极大，扩展运算符(...)有性能风险，但 JWT 签名只有 32 字节，安全
    base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): string {
  // 还原填充
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return atob(base64);
}
// ============ 密码哈希 ============
export function generateSalt(): string {
  const buffer = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(buffer).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyPassword(password: string, salt: string, hash: string): Promise<boolean> {
  const newHash = await hashPassword(password, salt);
  return newHash === hash;
}

// ============ JWT 相关（依赖环境变量） ============
// 将密钥和过期时间作为参数传入
export async function signJWT(
  payload: { userId: number; email: string },
  secret: string,
  expiresInMinutes: number
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const data = { ...payload, iat: now, exp: now + expiresInMinutes * 60 };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(data));
  const toSign = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(toSign));
  const sigB64 = base64UrlEncode(new Uint8Array(sigBuffer));
  return `${toSign}.${sigB64}`;
}

export async function verifyJWT(
  token: string,
  secret: string
): Promise<any | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const sigBuffer = Uint8Array.from(base64UrlDecode(sigB64), c => c.charCodeAt(0));
  const isValid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBuffer,
    encoder.encode(`${headerB64}.${payloadB64}`)
  );
  if (!isValid) return null;

  const payload = JSON.parse(atob(payloadB64));
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ============ 认证中间件（用于路由中） ============
// 接收 env 对象，以便从中读取密钥
export async function authenticate(
  request: Request,
  env: { JWT_SECRET: string }
): Promise<{ userId: number } | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return null;
  return { userId: payload.userId };
}
# LexiScribe API
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020.svg)](https://workers.cloudflare.com/)
[![Hono](https://img.shields.io/badge/Hono-4-e36002.svg)](https://hono.dev/)
[![D1](https://img.shields.io/badge/D1-SQLite-003682.svg)](https://developers.cloudflare.com/d1/)
[![R2](https://img.shields.io/badge/R2-Storage-003682.svg)](https://developers.cloudflare.com/r2/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](LICENSE)
> LexiScribe 的后端 API 服务 —— 智能英语句子间隔复习系统

基于 **Cloudflare Workers + Hono** 构建的轻量级 API 服务，使用 **D1** 作为主数据库、**R2** 作为对象存储、**KV** 作为缓存，完全运行于 Cloudflare 边缘网络，零服务器成本。

## ✨ 功能特性

- 🔐 **用户认证** — 注册 / 登录 / 邮箱验证 / JWT + HttpOnly Cookie
- 📝 **句子管理** — 增删改查、搜索、排序、分页
- 🔁 **间隔复习** — 四级评价（Again / Hard / Good / Easy）+ 动态间隔算法
- 🎵 **媒体处理** — 音频/视频上传、R2 存储、流式播放
- 🏆 **积分系统** — 每日登录、邀请注册、邮箱验证奖励 + 等级体系
- 📨 **邀请系统** — 专属邀请链接、IP/设备追踪、注册统计
- 👥 **小组协作** — 创建/加入小组、成员管理、句子分享、动态记录
- 🤖 **AI 辅助** — Whisper 语音转文字、M2M100 翻译（Cloudflare Workers AI）

## 🛠️ 技术栈

| 类别 | 技术 |
| :--- | :--- |
| **运行环境** | Cloudflare Workers |
| **Web 框架** | Hono |
| **数据库** | Cloudflare D1 (SQLite) |
| **对象存储** | Cloudflare R2 |
| **键值缓存** | Cloudflare KV |
| **认证** | JWT (HS256) + HttpOnly Cookie |
| **密码加密** | Web Crypto API (PBKDF2) |
| **参数校验** | Zod |
| **邮件服务** | Resend |
| **AI 模型** | Workers AI (Whisper / M2M100) |

## 📁 项目结构

```
src/
├── index.ts              # 入口（路由注册）
├── types/
│   └── binding.ts          # Bindings 类型定义
├── services/
│   └── PointsService.ts  # 积分服务
├── utils/
│   └── auth.ts           # authenticate 中间件 & 邀请码生成
└── routes/
    ├── auth.ts           # 认证
    ├── user.ts           # 用户资料
    ├── sentences.ts      # 句子 CRUD
    ├── media.ts          # 媒体上传
    ├── reviews.ts        # 复习
    ├── invitations.ts    # 邀请
    ├── points.ts         # 积分
    ├── groups.ts         # 小组
    ├── ai.ts             # AI 识别
    └── stats.ts          # 统计
```

## 🚀 本地开发

```bash
# 安装依赖
npm install

# 启动本地开发服务器（带 D1/R2 本地模拟）
wrangler dev --local

# 应用数据库迁移（本地）
wrangler d1 migrations apply DB --local
```

## ☁️ 部署

```bash
# 1. 在云端创建 D1 数据库
wrangler d1 create lexiscribe-prod

# 2. 在 wrangler.jsonc 中填入返回的 database_id

# 3. 应用数据库迁移
wrangler d1 migrations apply lexiscribe-prod --remote

# 4. 设置环境变量
wrangler secret put JWT_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put EMAIL_FROM

# 5. 部署
wrangler deploy
```

## 🔐 环境变量

| 变量名 | 说明 | 类型 |
| :--- | :--- | :--- |
| `JWT_SECRET` | JWT 签名密钥 | Secret |
| `JWT_EXPIRES_IN` | Token 过期时间（分钟） | Variable |
| `RESEND_API_KEY` | Resend 邮件 API Key | Secret |
| `EMAIL_FROM` | 发件邮箱 | Secret |
| `FRONTEND_URL` | 前端地址（用于生成邀请链接） | Variable |
| `MAX_FILE_SIZE` | 最大上传文件大小 | Variable |

## 📊 数据库表

| 表名 | 用途 |
| :--- | :--- |
| `users` | 用户信息 |
| `sentences` | 句子内容 + 媒体 |
| `reviews` | 复习记录 |
| `user_points` | 用户积分和等级 |
| `points_log` | 积分流水 |
| `invitations` | 邀请链接 |
| `invitation_records` | 邀请记录 |
| `groups` | 小组信息 |
| `group_members` | 小组成员 |
| `group_sentences` | 小组句子 |
| `group_activities` | 小组动态 |
| `notification_preferences` | 通知偏好 |

## 📌 关键设计

- **统一 UTC 存储**：数据库存 UTC 时间，前端负责转北京时间
- **Web Crypto 替代 bcrypt**：Workers 免费套餐 CPU 时间只有 10ms，同步加密库会超时
- **D1 存业务数据，KV 存缓存**：D1 支持关系查询，KV 只适合简单 Key-Value
- **R2 存媒体**：免费出口流量，成本低

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源。

```
MIT License

Copyright (c) 2024 Gold Price Monitor Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```


---

**Made with ❤️ by [Dragon](https://github.com/Chlorine001)**

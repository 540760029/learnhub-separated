# LearnHub · 课程学习与 AI 出题平台

面向高校课程的在线学习平台：**教师**发布课程/知识点/作业/试题并查看学情，
**学生**加入课程、交作业、做模拟题看解析，并可按自己的**薄弱知识点**让 AI 自动出题。

前后端分离的两个独立项目，后端固定跑 **本地 Node + MySQL**。

---

## 一、架构

```
┌─────────────────────────┐        跨源 HTTP          ┌──────────────────────────┐
│  frontend/  (端口 5173) │  ───────────────────────▶ │  backend/   (端口 8899)  │
│  原生 HTML/CSS/JS       │   /api/*  + CORS          │  Node + mysql2           │
│  零构建、零依赖          │  ◀─────────────────────── │  只提供 JSON 接口         │
└─────────────────────────┘                           └────────────┬─────────────┘
                                                                   │
                                                          ┌────────▼─────────┐
                                                          │   MySQL 8.x      │
                                                          │   库名 learnhub  │
                                                          └──────────────────┘
```

| | 说明 |
|---|---|
| **前端** | 纯静态资源，不含任何后端代码，**不托管 API**，可单独部署到任意静态托管/CDN |
| **后端** | 只提供 `/api/*` 的 JSON 接口，**不托管任何静态资源** |
| **数据库** | MySQL 8.x（`mysql2` 驱动） |
| **通信** | 浏览器直连后端，靠 CORS 跨源（`LEARNHUB_CORS_ORIGIN` 控制） |

---

## 二、快速开始

### 0. 准备

- Node.js **≥ 20.18**（用到 `--env-file-if-exists`）
- MySQL 8.x 已启动

建库建账号（本地图省事可以直接用 root）：

```sql
CREATE DATABASE learnhub DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'learnhub'@'%' IDENTIFIED BY '你的强密码';
GRANT ALL PRIVILEGES ON learnhub.* TO 'learnhub'@'%';
FLUSH PRIVILEGES;
```

### 1. 后端

```bash
cd backend
npm install
cp .env.example .env        # 然后按需改里面的数据库连接串与 LEARNHUB_SECRET
npm start                   # → http://127.0.0.1:8899
```

首次启动会自动完成两件事，都可用环境变量关掉：

- **幂等建表**（`LEARNHUB_AUTO_MIGRATE=0` 关闭）
- **空库灌演示数据**（`LEARNHUB_SEED=0` 关闭）

也可以手动分步执行：

```bash
npm run db:create     # 建库（若不存在）
npm run db:migrate    # 建表（幂等，可反复跑）
npm run db:seed       # 灌演示数据（仅空库）
npm run db:setup      # 上面三步一次做完
```

### 2. 前端

```bash
cd frontend
npm start                   # → http://127.0.0.1:5173
```

打开 **http://127.0.0.1:5173**，用下面的演示账号登录。

| 身份 | 邮箱 | 密码 |
|---|---|---|
| 管理员 | `admin@demo.edu` | `demo1234` |
| 教师 | `teacher@demo.edu` | `demo1234` |
| 学生 | `student@demo.edu` | `demo1234` |

课程邀请码 **`DEMO01`**

> 前端要指向别的后端（比如手机连你电脑）：加网址参数 `?api=http://192.168.1.10:8899`。
> 详见 [frontend/README.md](frontend/README.md)。

---

## 三、环境变量（后端）

全部写在 `backend/.env`（已 gitignore，模板见 `backend/.env.example`）。

| 变量 | 必填 | 说明 |
|---|---|---|
| `LEARNHUB_DB_URL` | ✅ | `mysql://user:pass@host:3306/learnhub` |
| `LEARNHUB_SECRET` | ✅ 上线必改 | 会话签名 + API Key 加密主密钥。默认值公开，**不换等于把管理员权限送人** |
| `LEARNHUB_TEST_DB_URL` | | 测试库连接串。**库名必须以 `_test` 结尾**，测试会 DROP 重建它 |
| `PORT` / `HOST` | | 监听地址，默认 `8899` / `127.0.0.1` |
| `LEARNHUB_CORS_ORIGIN` | | 允许跨源的前端来源。`*`（默认）放行全部；也可写逗号分隔白名单 |
| `LEARNHUB_DEFAULT_PROVIDER` | | 默认 AI 服务商，默认 `deepseek` |
| `LEARNHUB_DAILY_AI_LIMIT` | | 教师/学生每日出题套数，默认 3（管理员可后台改） |
| `LEARNHUB_PLATFORM_API_KEY` | | 平台 Key 的初始化兜底；正常应在管理员后台上传 |
| `LEARNHUB_AUTO_MIGRATE` | | `1`（默认）启动时幂等建表，`0` 关闭 |
| `LEARNHUB_SEED` | | `1`（默认）空库自动灌演示数据，`0` 关闭 |

生成随机密钥：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

> ⚠️ `LEARNHUB_SECRET` 换了之后，用户之前存进库里的 API Key 会**解不开**（需重新填），
> 所以第一次上线就设好，并注意备份。

---

## 四、测试

两个项目各自独立测试：

```bash
cd backend  && npm test      # 64 项：跑在真实 MySQL 上
cd frontend && npm test      #  6 项：静态服务
```

### 后端测试为什么连真库

后端只用 MySQL，所以测试也直接跑在真实 MySQL 8.x 上 ——
这样顺带验证了 MySQL 方言（保留字、`TEXT`/`VARCHAR`、索引、唯一约束错误码）没有踩坑。

每次运行会 **DROP 并重建** `LEARNHUB_TEST_DB_URL` 指向的库，保证从空表开始。

**安全保护**：测试只读 `LEARNHUB_TEST_DB_URL`，从不读 `LEARNHUB_DB_URL`；
且库名必须严格匹配 `^[A-Za-z0-9_]+_test$`，否则直接拒绝运行 ——
万一连接串被误配成业务库，这道校验能挡住整库被删。

```bash
# backend/.env 里
LEARNHUB_DB_URL=mysql://root:密码@127.0.0.1:3306/learnhub          # 业务库，测试不碰
LEARNHUB_TEST_DB_URL=mysql://root:密码@127.0.0.1:3306/learnhub_test # 测试库，会被清空
```

---

## 五、目录结构

```
learnhub-separated/
├── backend/
│   ├── server.js            启动入口
│   ├── .env.example         环境变量模板
│   ├── src/
│   │   ├── app.js           全部 API 路由 + 权限 + AI 编排 + CORS
│   │   ├── router.js        极简 Fetch 风格路由器（零框架依赖）
│   │   ├── drivers.js       MySQL 驱动层（mysql2 是唯一的运行期依赖）
│   │   ├── db.js            数据访问层（裸 SQL，原生 MySQL 方言）
│   │   ├── security.js      PBKDF2 密码 / HMAC 会话 / AES-GCM 加密 Key
│   │   ├── llm.js           6 家 OpenAI 兼容服务商 + 出题 + 资料→知识点 + 离线 Mock
│   │   ├── config.js        配置解析
│   │   ├── bootstrap.js     装配（连库 + 建表 + 种子 + 应用）
│   │   └── node-adapter.js  Node HTTP ↔ Fetch 适配
│   ├── migrations/mysql/
│   │   └── 0001_schema.sql  唯一 schema 事实来源（纯 DDL）
│   ├── scripts/             建库 / 迁移 / 种子 / 密码哈希
│   └── test/                64 项端到端测试（连真实 MySQL）
│
├── frontend/
│   ├── index.html           页面骨架 + SPA 视图
│   ├── app.css              样式
│   ├── app.js               交互逻辑（路由、请求封装、视图渲染）
│   ├── config.js            运行时配置：后端地址
│   ├── server.js            零依赖静态服务器（开发用）
│   └── test/                6 项静态服务测试
│
├── tools/
│   ├── start-all.ps1                    一键拉起后端 + 前端 + 隧道
│   └── cloudflared.config.example.yml   隧道分流配置模板
└── README.md
```

### 为什么不用 Express

后端刻意保留 Fetch 风格的 `Request`/`Response` 与自写的约 180 行路由器
（`src/router.js`），业务代码因此不绑定任何 HTTP 框架 —— 测试里可以直接用
`fetch` 打真实端口。Express 依赖 `on-finished` 读取 `req.socket`，在这种
Fetch 抽象下会直接崩，所以不用它。

---

## 六、功能清单

### 管理员（平台级）
- **🔑 平台 AI Key**：上传/更新平台默认 Key（AES-GCM 加密存库，**对全体用户生效**）
  - 选服务商（DeepSeek / OpenAI / 通义 / 智谱 / Kimi / 自定义）、自定义模型与 Base URL
  - 调整教师/学生每日额度；启用/停用；留空不覆盖；一键测试连通性；清除 Key
- **总览**：用户/教师/学生/管理员数、课程、知识点、试题、题目、作业、提交、答题记录、今日 AI 调用
- **用户管理**：搜索、改角色、设为/取消管理员、停用/启用、删除
- **课程管理**：全部课程列表、进入任意课程、删除课程

### 教师
- 建课 → 自动生成**邀请码**；发布知识点（全班可见 / 仅教师可见）
- **上传资料自动整理知识点**：`.txt / .md / .csv` → AI 切分 → 预览可逐条编辑 → 选可见范围入库
- 发布作业、查看提交、打分写评语
- 手工组卷（单选/多选/判断，**缺解析会被拒绝**）
- **试题列表与详情**：答案解析 + 每题正确率 + 作答人次/人数/均分 + 学生明细与错题号
- 随时切换试卷可见性；**学情分析看板**（班级薄弱知识点排行、学生明细、答题趋势）

### 学生
- 凭邀请码加入课程；看知识点、交作业（可反复更新直到被打分）
- 做模拟题 → **提交前校验完成度**（没做完不允许提交，可点题号跳过去继续做）
  → 交卷后**逐题标绿正确选项 + 详细解析** → 可**重新作答**（历史成绩保留）
- **AI 智能出题**：按薄弱知识点出题，生成的题**仅自己可见**
- **添加自己的课程笔记**（强制仅本人可见；教师可见以便答疑，同学看不到）

---

## 七、AI 出题额度规则

平台默认 Key 由管理员在后台配置，**对全体用户生效**；额度上限也可随时调整。

| 角色 / 用谁的 Key | 额度 |
|---|---|
| 任何角色**用自己的 Key** | **不限次数** |
| **管理员**（用平台默认 Key） | **不限次数** |
| 教师（用平台默认 Key） | 每日 **N** 套（默认 3，管理员可改） |
| 学生（用课程教师 / 平台默认 Key） | 每日 **N** 套 |
| 平台 Key 未配置或已停用 | 降级为**离线模拟题**，流程照常可演示 |

Key 优先级：**自己的 Key → 管理员配置的平台 Key → 课程教师的 Key → 平台 Key（限次）**

- 生成**失败不扣额度**（只在成功落库后才计数）
- API Key 用 **AES-256-GCM** 加密入库，接口只回显**后 4 位**，连管理员也取不回明文

---

## 八、可见性（scope）模型

知识点与试题都带 `scope`，三档：

| scope | 谁能看到 | 谁创建 |
|---|---|---|
| `course` | 全班（所有学生 + 教师） | 教师 |
| `teacher` | 仅教师（学生完全不可见） | 教师 |
| `private` | 仅创建者本人（教师可见以便答疑） | 学生（强制） |

学生**无法**把自己的知识点或试题设为公开——后端强制改写为 `private`，
绕过前端直接调 API 也会被拦（有测试覆盖）。

---

## 九、部署

### 后端（systemd 常驻）

```ini
# /etc/systemd/system/learnhub-api.service
[Unit]
Description=LearnHub API
After=network.target mysql.service

[Service]
WorkingDirectory=/opt/learnhub/backend
EnvironmentFile=/opt/learnhub/backend/.env
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now learnhub-api
```

### 前端（Nginx，推荐与后端同源）

用 Nginx 同时发静态文件并把 `/api` 反代到后端，这样前后端同源、连 CORS 都不用配。
完整配置见 [frontend/README.md](frontend/README.md)。

同源部署时 `frontend/config.js` 会自动改用同源相对路径（非 localhost 环境 `apiBase` 取空串），
不用手改配置。

### Cloudflare Tunnel（不买服务器，把本机服务开放到公网）

不需要公网 IP、不需要备案。用**同一个域名**把后端(8899) 与前端(5173) 暴露出去：

```
learn.你的域名.com/api/*  →  127.0.0.1:8899   （后端）
learn.你的域名.com/*      →  127.0.0.1:5173   （前端）
```

**为什么用单域名 + 路径分流**：前后端同源，浏览器不触发跨源，连 CORS 都不用配。
前端 `config.js` 在非 localhost 环境下会自动改用同源相对路径（见该文件注释），
所以同一份前端代码既能本机开发、也能走隧道上线，不用改配置。

`%USERPROFILE%\.cloudflared\config.yml`（模板见 `tools/cloudflared.config.example.yml`）：

```yaml
tunnel: <Tunnel ID>
credentials-file: C:\Users\<你>\.cloudflared\<Tunnel ID>.json

ingress:
  - hostname: learn.你的域名.com
    path: ^/api/
    service: http://127.0.0.1:8899
  - hostname: learn.你的域名.com
    service: http://127.0.0.1:5173
  - service: http_status:404
```

> ⚠️ **`path` 是 Go 正则，不是通配符**。网上很多例子写 `path: /api/*`，那是错的 ——
> 正则里 `*` 只作用于前一个 `/`，匹配不到 `/api/courses`，结果是所有接口都被前端
> 静态服务器接走，返回 404 或 HTML。正确写法是 `^/api/`。

首次创建隧道：

```bash
cloudflared tunnel login
cloudflared tunnel create learnhub            # 记下输出的 Tunnel ID
cloudflared tunnel route dns learnhub learn.你的域名.com
```

之后一键拉起三个进程（后端 + 前端 + 隧道）：

```powershell
powershell -ExecutionPolicy Bypass -File tools\start-all.ps1
```

**改完配置别急着上线**，先离线试跑分流规则（不需要隧道真的连上）：

```bash
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule https://learn.你的域名.com/api/courses   # 应匹配 8899
cloudflared tunnel ingress rule https://learn.你的域名.com/app.js        # 应匹配 5173
```

> ⚠️ **Windows 上配置文件必须存成无 BOM 的 UTF-8**：cloudflared 读到 BOM 会报
> `invalid character 'ï' looking for beginning of value` 而启动失败。
> PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，别用它。

**暴露到公网后的安全检查**：隧道一旦接通，任何人拿到域名都能访问，务必改掉演示账号
密码、把 `LEARNHUB_SECRET` 换成随机值。同源部署下浏览器不会跨源，CORS 其实用不到，
`LEARNHUB_CORS_ORIGIN` 保持默认即可。

### 上线检查清单

- [ ] `LEARNHUB_SECRET` 已设为随机值（且**已备份**：换了之后用户已存的 Key 解不开）
- [ ] `LEARNHUB_CORS_ORIGIN` 已从 `*` 收窄为实际前端域名（同源部署可不管）
- [ ] 隧道配置里 `path` 用的是 `^/api/`，并用 `cloudflared tunnel ingress rule` 试跑确认过
- [ ] 演示账号要么改密码，要么删掉（`admin@demo.edu` / `teacher@demo.edu` / `student@demo.edu`）
- [ ] `LEARNHUB_SEED=0`（避免往生产库灌演示数据）
- [ ] 平台 AI Key 由管理员登录后台「🔑 平台 AI Key」上传
- [ ] 确认 `.env` 没有被提交进仓库
- [ ] 后端 `npm test` 与前端 `npm test` 都全绿

---

## 十、许可证

[MIT License](LICENSE) · Copyright (c) 2026 李小凡 (Xiaofan Li)

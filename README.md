# 底层创造者 OS · 多用户版

一个基于**负反馈自控理论**的个人操作系统仪表盘。原本是单文件 HTML + LocalStorage 的个人工具，这一版重写为 **Node + Express + SQLite** 的多用户 Web 应用：任何人都能注册账号，数据存在服务器，天生多端同步。

相比单机版的变化：

| | 单机版 | 多用户版（本项目） |
|---|---|---|
| 数据存放 | 浏览器 LocalStorage | 服务器 SQLite，每用户一份 |
| 多端同步 | 手动填同步码 + GitHub API | 登录即同步，无需任何配置 |
| 用户 | 只有你自己 | 任意多人，数据互相隔离 |
| 模块 | 含医学 / 成人内容戒断 | **已移除**，保留通用「坏习惯戒断」链 |
| 默认内容 | 作者的四年个人规划 | 通用启动模板，日期按注册当天生成 |

---

## 一、核心概念（先懂这个，再看代码）

整套东西是把**控制论的负反馈闭环**套在人身上：

```
目标（规则树）→ 执行（每日打卡）→ 采样（完成率/事件/标记）
      ↑                                        ↓
      └──────── 修正（三级复盘 + 定式迭代）────────┘
```

四个关键设计：

1. **规则树 = 门类 × 层级 × 规则**
   门类（学习/专注/娱乐/戒断/生活）是横轴，层级（根部/中层/顶层）是纵轴。
   根部是保命线，顶层是理想态。崩溃时只保根部，这叫**降级而不是放弃**。

2. **支链系统（本项目最有价值的设计）**
   规则带 `parent` 字段。`parent=null` 是主链节点；挂在某节点下的是它的**支链**。
   主链节点崩了（比如没能按时起床），支链自动激活（补觉≤20min → 洗漱后直接出门）。
   关键在于：**未激活的支链不计入进度分母**（`activeRoots()`），所以你不会因为走了 B 计划而被扣分。这消除了「反正今天已经废了」的崩盘心理。

3. **日标记的降级机制**
   给某天打上「社交日 / 高扰动 / 低能量日」标记（`degrade:true`），当天的评价标准自动放宽。承认环境扰动客观存在，而不是假装每天条件都一样。

4. **三级复盘 + 定式迭代台**
   日 / 周 / 月三个采样频率。规则崩溃时不是自责，而是去「定式迭代台」改规则——**规则不合理就改规则**，这才是闭环的「修正」环节。

---

## 二、技术架构

```
浏览器                          服务器
┌──────────────────┐          ┌─────────────────────────┐
│ index.html       │          │ server.js (Express)     │
│  ├ 内存 bag      │          │  ├ /api/register        │
│  ├ localStorage  │◄────────►│  ├ /api/login /logout   │
│  │  （本地镜像） │  session │  ├ /api/me              │
│  └ 防抖 1.5s     │  cookie  │  ├ GET  /api/data       │
│     PUT /api/data│          │  └ PUT  /api/data       │
└──────────────────┘          │         ↓               │
                              │  SQLite (data.db, WAL)  │
                              │   users / profiles      │
                              └─────────────────────────┘
```

**数据流**：
- 前端所有读写仍走原来的 `store` 抽象（写 localStorage），改动后触发 `scheduleServerSave()`，防抖 1.5 秒把**整包** JSON `PUT` 到服务器。
- 登录成功 → `loadFromServer()` 拉取整包 → **先清空 localStorage 镜像**（防串号）→ 写回内存变量和本地镜像 → `bootApp()` 渲染。
- 整包覆盖而非增量 diff。数据量小（一年打卡也就几百 KB），换来的是逻辑极简、不会出现合并冲突。

**数据表**：

```sql
users    (id, username UNIQUE, pw_hash, created_at)
profiles (user_id PRIMARY KEY, data TEXT /* 整包 JSON */, updated_at)
```

**安全措施**：
- 密码 `bcryptjs` 加盐哈希（10 轮），数据库里不存明文。
- session cookie 设 `httpOnly` + `sameSite=lax`，生产环境自动加 `secure`。
- 所有数据接口过 `requireAuth`，未登录一律 401。
- `PUT /api/data` 强制剥离 `meta.ghToken` 等令牌字段（安全护栏，本项目已无 GitHub 同步）。
- 用户之间通过 `req.session.userId` 隔离，无法读到别人的 `profiles` 行。

---

## 三、本地跑起来

```bash
cd rootos-webapp
npm install
npm start
# → http://localhost:3000
```

打开后是登录页，点「注册新账号」，用户名 ≥2 字符、密码 ≥6 位。

**自检脚本**：

```bash
node tools/check_frontend.js   # 前端静态检查：语法 / 残留引用 / 事件函数 / 元素 id
node tools/e2e_test.js         # 多用户端到端测试（需服务器已启动），34 项断言
```

---

## 四、部署到云服务器（VPS）

以 Ubuntu 22.04 + 域名 `os.example.com` 为例。整套下来大概 15 分钟。

### 4.1 准备服务器

买一台最低配 VPS 就够（1 核 1G，腾讯云轻量 / 阿里云 ECS / Vultr 都行）。SQLite 是单文件数据库，不需要额外的数据库服务。

```bash
ssh root@你的服务器IP

# 装 Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git build-essential

node -v   # 应该 >= 18
```

> `build-essential` 是给 `better-sqlite3` 兜底用的。绝大多数情况它会直接下预编译二进制，不需要编译。

### 4.2 上传代码

```bash
# 方式 A：用 git（推荐，方便以后更新）
mkdir -p /opt && cd /opt
git clone https://github.com/你的用户名/rootos-webapp.git
cd rootos-webapp

# 方式 B：本地直接 scp 上去
# scp -r "D:/work workbuddy/rootos-webapp" root@你的IP:/opt/
```

```bash
npm install --omit=dev
```

### 4.3 设置环境变量

**必须改 session 密钥**，否则用默认值等于没有安全性：

```bash
# 生成一个随机密钥
openssl rand -hex 32
# 输出类似：3f9a1c...（复制它）

# 写进环境文件
cat > /opt/rootos-webapp/.env <<'EOF'
NODE_ENV=production
PORT=3000
SESSION_SECRET=把上面生成的随机串粘到这里
EOF
chmod 600 /opt/rootos-webapp/.env
```

| 变量 | 作用 | 不设会怎样 |
|---|---|---|
| `SESSION_SECRET` | 签名 session cookie | 用硬编码默认值，任何人都能伪造登录态 |
| `NODE_ENV=production` | 开启 cookie `secure` 标志 | cookie 会在 http 明文传输 |
| `PORT` | 监听端口 | 默认 3000 |

### 4.4 用 pm2 常驻

```bash
npm install -g pm2

cd /opt/rootos-webapp
pm2 start server.js --name rootos --env-file .env

pm2 save              # 保存当前进程列表
pm2 startup           # 按提示复制粘贴它输出的那行命令，实现开机自启

pm2 logs rootos       # 看日志
pm2 restart rootos    # 改代码后重启
```

> 如果 pm2 版本较老不支持 `--env-file`，改用：
> `set -a && source .env && set +a && pm2 start server.js --name rootos`

### 4.5 Nginx 反向代理 + HTTPS

```bash
apt-get install -y nginx certbot python3-certbot-nginx
```

写配置 `/etc/nginx/sites-available/rootos`：

```nginx
server {
    listen 80;
    server_name os.example.com;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/rootos /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# 自动申请 Let's Encrypt 证书并改写配置为 HTTPS
certbot --nginx -d os.example.com
```

证书 90 天自动续期，certbot 已经装好定时任务，不用管。

**重要**：启用 HTTPS 后，因为 `NODE_ENV=production` 会给 cookie 加 `secure` 标志，必须让 Express 信任代理，否则登录会失败。在 `server.js` 的 `app` 创建后加一行：

```js
app.set('trust proxy', 1);
```

（本仓库已包含这行，若你从更早版本升级请自行补上。）

### 4.6 防火墙

```bash
ufw allow 22
ufw allow 80
ufw allow 443
ufw enable
```

注意**不要**放行 3000 端口——Node 只监听本机，外部一律走 Nginx。

### 4.7 备份

数据全在一个文件里，备份就是复制文件：

```bash
# 手动备份
cp /opt/rootos-webapp/data.db /root/backup/data-$(date +%F).db

# 每天凌晨 3 点自动备份，保留 30 天
crontab -e
# 加入这一行：
0 3 * * * sqlite3 /opt/rootos-webapp/data.db ".backup '/root/backup/rootos-$(date +\%F).db'" && find /root/backup -name 'rootos-*.db' -mtime +30 -delete
```

> 用 `sqlite3 .backup` 而不是 `cp`，因为开了 WAL 模式，直接 cp 可能拷到不一致的状态。先 `apt-get install sqlite3`。

### 4.8 更新代码

```bash
cd /opt/rootos-webapp
git pull
npm install --omit=dev
pm2 restart rootos
```

`data.db` 不在 git 里（见 `.gitignore`），更新不会动用户数据。

---

## 五、目录结构

```
rootos-webapp/
├── server.js              # 后端：Express + SQLite + 认证 + 数据 API
├── package.json
├── public/
│   └── index.html         # 前端单文件（HTML+CSS+JS 全在里面）
├── tools/
│   ├── check_frontend.js  # 前端静态检查
│   └── e2e_test.js        # 多用户端到端测试
├── data.db                # SQLite 数据库（自动生成，勿提交）
└── README.md
```

---

## 六、二次开发提示

- **改默认模板**：同时改 `server.js` 的 `defaultBag()` 和 `public/index.html` 的 `SEED_*`，两边要一致（前者是服务器默认值，后者是离线兜底）。
- **加字段**：在 `bagKeys` 数组里加键名，前后端都要加。整包存储，不用改表结构。
- **换数据库**：`profiles.data` 是一整个 JSON 字符串，换 Postgres / MySQL 只需替换 `db.prepare(...)` 那几行。
- **加多端实时推送**：目前是「登录时拉一次 + 改动防抖上传」。要做实时同步可以加 WebSocket，或者简单点用 `setInterval` 轮询 `GET /api/data` 比对 `updated_at`。

---

## 七、已知取舍

- **整包覆盖**：两个设备同时在线编辑，后保存的覆盖先保存的。个人工具场景够用；要多人协作得上 CRDT 或字段级 diff。
- **session 存内存**：`express-session` 默认 MemoryStore，服务器重启后所有人需要重新登录。要持久化可以接 `connect-sqlite3`。
- **无找回密码**：没有邮箱体系。忘密码只能进数据库手动改 `pw_hash`。

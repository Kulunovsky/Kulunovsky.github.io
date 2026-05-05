# BA Scout Web - 单人查询版

这个项目可以直接推到 GitHub，然后用 Cloudflare Pages + Cloudflare Worker 搭建网页。

## 功能

- 单人玩家查询
- 输入玩家 ID / 昵称
- 可选输入 ELO
- 样本数量：25 / 50 / 75 / 100
- 查询 BATrace 第三方数据源
- ELO 曲线图
- 基础雷达图
- 透明 UI
- 固定文件夹壁纸轮播：每 10 秒切换一次
- 页面底部声明：
  - 项目作者： kulunovsky
  - 数据源于第三方，实际数据以游戏为准

## 壁纸怎么放

把图片放进：

```text
frontend/public/backgrounds/
```

推荐命名：

```text
01.jpg
02.jpg
03.jpg
04.jpg
05.jpg
```

也支持：

```text
01.png
01.webp
02.png
02.webp
...
```

程序会自动尝试加载 `01-20` 这些编号里的 jpg/png/webp 文件，能加载到哪些就轮播哪些。

如果没有放图片，网页会使用默认深色背景。

## 本地运行 Worker

```bash
cd worker
npm install
npm run dev
```

测试：

```text
http://localhost:8787/api/health
```

## 本地运行前端

另开一个终端：

```bash
cd frontend
npm install
npm run dev
```

打开：

```text
http://localhost:5173
```

## 部署 Worker

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

部署后你会得到一个 Worker 地址，例如：

```text
https://ba-scout-worker.<your-name>.workers.dev
```

## 配置前端生产 API 地址

复制：

```text
frontend/.env.production.example
```

改名为：

```text
frontend/.env.production
```

把里面的地址改成你的 Worker 地址：

```env
VITE_API_BASE=https://ba-scout-worker.<your-name>.workers.dev
```

## 部署前端到 Cloudflare Pages

把 `frontend` 目录推到 GitHub 仓库，然后 Cloudflare Pages 选择该仓库。

构建设置：

```text
Build command: npm run build
Build output directory: dist
```

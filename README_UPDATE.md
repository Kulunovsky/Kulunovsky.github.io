# BA Scout Web Full Detail Update

把这个压缩包里的文件覆盖到你现有项目对应位置：

```text
frontend/src/App.tsx
frontend/src/style.css
frontend/src/vite-env.d.ts
frontend/functions/api/health.ts
frontend/functions/api/analyze-player.ts
```

然后进入 frontend：

```powershell
cd frontend
npm run build
npx wrangler pages deploy dist --project-name ba-scout-web --branch main --commit-dirty=true
```

这个版本补回了客户端详情页里的主要数据：

- 近期表现
- 长期累计表现
- 单位管理与风险
- 占点与补给
- MVP 贡献细分
- 最近对局兵种类别分析
- 长期兵种偏好
- 国家偏好
- 专精偏好
- 常用专精组合
- 常用 / 高光单位
- 地图表现
- 数据提示
- 404 对局详情统计

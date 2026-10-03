# 易获易成销售副驾

保险销售 AI 辅助工作台，本地可运行原型。包含客户画像、产品匹配、回复草稿、风险提醒和评测支撑模块。

## 运行
需要 Node.js 24 或更新版本，首次运行先执行 `npm install`。

```sh
LOCAL_PORT=8834 node scripts/start-integrated-workbench.mjs
```

打开 http://127.0.0.1:8834/sales-copilot.html?mode=sidebar 。

未配置 AI 服务时可查看本地预览；真实模型、ASR 等能力需要自行配置环境变量。密钥与本地数据库不包含在仓库中。
企业微信真实客户识别、授权消息获取与发送尚未接通；预览发送为本地模拟。

本仓库为源项目的独立整理副本，不含原项目 Git 历史、真实运行数据或课程资料。

## DeepSeek 文本 AI

设置服务端环境变量 `DEEPSEEK_API_KEY` 后，副驾的回复生成、画像/意向提取、产品候选解释优先使用 DeepSeek。默认 `deepseek-flash`、开启思考、high、非流式；可用 `DEEPSEEK_MODEL` 覆盖模型名。原有规则校验和销售确认保持有效。未设置时沿用原 Dify 配置。ASR 不使用此 Key。

本地将 Key 放入 `.env.local`（已忽略，不要提交），或注入进程环境变量。

Vercel 环境变量只对 Vercel 服务端函数有效。本仓库目前是 Node + SQLite 服务，不能仅以静态 dist 部署后就获得后端能力。真实客户数据需要持久后端/云数据库；不要将 SQLite 改到临时目录后用于真实业务。

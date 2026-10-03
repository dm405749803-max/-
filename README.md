# 易获易成销售副驾

保险销售 AI 辅助工作台，本地可运行原型。包含客户画像、产品匹配、回复草稿、风险提醒和评测支撑模块。

## 运行
需要 Node.js 24 或更新版本，无需 npm install。

```sh
LOCAL_PORT=8834 node scripts/start-integrated-workbench.mjs
```

打开 http://127.0.0.1:8834/sales-copilot.html?mode=sidebar 。

未配置 AI 服务时可查看本地预览；真实模型、ASR 等能力需要自行配置环境变量。密钥与本地数据库不包含在仓库中。
企业微信真实客户识别、授权消息获取与发送尚未接通；预览发送为本地模拟。

本仓库为源项目的独立整理副本，不含原项目 Git 历史、真实运行数据或课程资料。

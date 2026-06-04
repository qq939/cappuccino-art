# 卡布奇诺拉花 ☕🎨

上传照片，AI 生成咖啡厅卡布奇诺拉花艺术图片。

## 功能

- 上传任意照片 → 生成卡布奇诺咖啡拉花效果
- 自定义提示词
- 生成图自动替换 Demo 展示
- 点击标题恢复初始 Demo
- 历史记录

## 技术栈

- Node.js + Express
- Coze Workflow API（工作流 ID: 7647377698306129920）
- OBS 中转上传

## 部署

```bash
npm install
cp .env.example .env  # 编辑配置
node server.js
```

## 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| COZE_API_KEY | Coze PAT 令牌 | ✅ |
| COZE_WORKFLOW_ID | 工作流 ID | ✅ |
| PORT | 端口号（默认 8083） | ❌ |

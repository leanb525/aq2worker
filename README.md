# Amazon Q to Claude API Bridge

[![Version](https://img.shields.io/badge/version-2.1.0-blue.svg)](https://github.com/yourusername/amazonq_worker)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

将 Amazon Q API 转换为 Anthropic Claude API 和 OpenAI API 格式的 Cloudflare Worker 桥接服务。

## ✨ 特性

- ✅ **工具调用优化**：自动处理 Amazon Q 的 10k description 限制
- ✅ **Token 计数**：估算并返回 input/output tokens，支持 Claude Code 上下文管理
- ✅ **系统提示词**：正确处理 Claude API 的 system 消息
- ✅ **消息配对**：自动确保 user/assistant 消息成对（Amazon Q 要求）
- ✅ **Ping 事件**：支持 Claude Code 的连接保活和 UI 动画
- ✅ **流式响应**：完整的 SSE 事件支持
- ✅ **双格式支持**：同时支持 Anthropic 和 OpenAI API 格式
- ✅ **自动 Token 刷新**：后台自动刷新过期的 access token

## 📚 文档

- [部署指南](DEPLOYMENT_GUIDE.md) - 详细的部署步骤
- [优化说明](OPTIMIZATIONS.md) - 技术细节和优化内容

---

## 快速开始

### 准备工作

确保你有：
- Cloudflare 账号（免费版即可）
- Amazon Q 的认证凭证（clientId, clientSecret, refreshToken）

---

## 方法一：通过 Cloudflare Dashboard 部署（推荐）

### 第一步：创建 Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 在左侧菜单选择 **Workers & Pages**
3. 点击 **Create application** 按钮
4. 选择 **Create Worker**
5. 给 Worker 命名（如：`amazon-q-api-bridge`）
6. 点击 **Deploy** 创建 Worker

### 第二步：上传代码

1. 在 Worker 详情页，点击 **Quick edit** 按钮
2. 删除默认代码
3. 将 `worker.js` 的全部内容复制粘贴进去
4. 点击右上角 **Save and Deploy**

### 第三步：创建 KV Namespace

1. 返回到 **Workers & Pages** 主页
2. 点击顶部导航的 **KV** 标签
3. 点击 **Create a namespace** 按钮
4. 命名为：`amazonq_credentials`
5. 点击 **Add** 创建
6. **重要：记录下生成的 Namespace ID**（一串字母数字，例如：`1234567890abcdef1234567890abcdef`）

### 第四步：绑定 KV 到 Worker

1. 回到 **Workers & Pages** → 找到你的 Worker
2. 点击进入 Worker 详情页
3. 选择 **Settings** 标签
4. 在左侧菜单选择 **Variables**
5. 向下滚动到 **KV Namespace Bindings** 部分
6. 点击 **Add binding**
7. 填写：
   - **Variable name**: `AMAZONQ_KV`（必须精确匹配）
   - **KV namespace**: 从下拉菜单选择刚创建的 `amazonq_credentials`
8. 点击 **Save**

### 第五步：设置认证凭证

部署完成后，使用 API 设置凭证：

```bash
curl -X POST https://你的worker地址.workers.dev/credentials \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "XVzLWVhc3QtMQ",
    "clientSecret": "eyJraWQiOiJrZXktMTU2NDAy...(完整的token)",
    "refreshToken": "aorAAAAAGmEpW0BqAaQuIlvP...(完整的token)"
  }'
```

**注意**：请替换为你的实际凭证。

成功响应：
```json
{
  "message": "凭证设置成功",
  "has_profile_arn": false
}
```

### 第六步：测试服务

访问你的 Worker URL，应该看到：

```bash
curl https://你的worker地址.workers.dev/

# 响应示例：
{
  "message": "Amazon Q to OpenAI API Bridge",
  "version": "2.1.0",
  "features": [
    "Tool calling with 10k description limit",
    "Input tokens estimation",
    "System prompt handling",
    "Message pairing for Amazon Q",
    "Ping events for Claude Code"
  ]
}
```

测试健康检查：

```bash
curl https://你的worker地址.workers.dev/health

# 响应示例：
{
  "status": "ok",
  "timestamp": "2025-11-11T15:00:00.000Z",
  "has_credentials": true
}
```

---

## 方法二：使用 Wrangler CLI 部署

### 前置条件

确保已安装 Node.js (v18+)。

### 第一步：安装 Wrangler

```bash
npm install wrangler --save-dev
```

### 第二步：登录 Cloudflare

```bash
npx wrangler login
```

这会打开浏览器进行 OAuth 认证。

### 第三步：创建 KV Namespace

```bash
npx wrangler kv:namespace create "AMAZONQ_KV"
```

命令会输出类似内容：

```
🌀 Creating namespace with title "amazon-q-api-bridge-AMAZONQ_KV"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "AMAZONQ_KV", id = "1234567890abcdef1234567890abcdef" }
```

**复制这个 ID**。

创建 Preview namespace（用于本地开发）：

```bash
npx wrangler kv:namespace create "AMAZONQ_KV" --preview
```

同样复制输出的 `preview_id`。

### 第四步：更新 wrangler.toml

编辑 `wrangler.toml` 文件，将 placeholder 替换为实际的 ID：

```toml
name = "amazon-q-api-bridge"
main = "worker.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "AMAZONQ_KV"
id = "你的实际ID"
preview_id = "你的preview_id"
```

### 第五步：部署

```bash
npx wrangler deploy
```

部署成功后会显示 Worker URL。

### 第六步：设置凭证

使用第一种方法的"第五步"设置凭证。

---

## 使用自定义域名（可选）

### 在 Cloudflare Dashboard 配置

1. 进入 Worker 详情页 → **Triggers** 标签
2. 在 **Custom Domains** 部分点击 **Add Custom Domain**
3. 输入你的域名（如：`api.example.com`）
4. 点击 **Add Custom Domain**
5. Cloudflare 会自动配置 DNS 记录

---

## API 使用示例

### OpenAI 格式调用

```bash
curl https://你的worker地址.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "messages": [
      {"role": "user", "content": "你好，请介绍一下你自己"}
    ],
    "stream": false
  }'
```

### Anthropic 格式调用

```bash
curl https://你的worker地址.workers.dev/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4.5",
    "messages": [
      {"role": "user", "content": "你好"}
    ],
    "max_tokens": 1024
  }'
```

### 流式响应

```bash
curl https://你的worker地址.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "messages": [
      {"role": "user", "content": "讲个笑话"}
    ],
    "stream": true
  }'
```

---

## 查看和管理凭证

### 检查凭证状态

```bash
curl https://你的worker地址.workers.dev/credentials
```

响应：
```json
{
  "has_credentials": true,
  "has_access_token": true,
  "token_expiry": "2025-11-12T15:00:00.000Z"
}
```

### 更新凭证

重新 POST 到 `/credentials` 端点即可覆盖旧凭证。

---

## 常见问题

### Q1: 如何获取 Amazon Q 的认证凭证？

A: 这些凭证通常来自 AWS IAM Identity Center (SSO) 或 AWS IDE Extensions。你需要从 VSCode 的 AWS Toolkit 扩展中提取。

### Q2: Token 过期怎么办？

A: Worker 会自动使用 `refreshToken` 刷新 `accessToken`，无需手动操作。

### Q3: 如何查看 Worker 日志？

在 Cloudflare Dashboard：
1. 进入 Worker 详情页
2. 点击 **Logs** 标签
3. 点击 **Begin log stream**

或使用 CLI：
```bash
npx wrangler tail
```

### Q4: 凭证存储在哪里？

凭证加密存储在 Cloudflare KV 中，安全可靠。

### Q5: 费用如何？

Cloudflare Workers 免费套餐：
- 每天 100,000 次请求
- KV 存储 1GB
- KV 读取 100,000 次/天

对于个人使用完全足够。

---

## 安全建议

1. **不要将凭证硬编码**在 worker.js 中
2. **使用 HTTPS**：Cloudflare 默认提供免费 SSL
3. **限制访问**：可以在 Worker 中添加 API Key 验证
4. **定期轮换凭证**：建议每隔几个月更新一次 refreshToken
5. **监控使用情况**：通过 Cloudflare Analytics 监控异常流量

---

## 故障排查

### Worker 返回 500 错误

检查：
1. KV Namespace 是否正确绑定
2. 凭证是否已设置
3. 查看 Worker 日志获取详细错误

### 认证失败（403 错误）

可能原因：
1. refreshToken 已过期 - 需要重新获取
2. clientId/clientSecret 不匹配

### 无法访问 Worker URL

检查：
1. Worker 是否已成功部署
2. 网络连接是否正常
3. URL 是否正确

---

## 更新 Worker

### 通过 Dashboard 更新

1. 进入 Worker 详情页
2. 点击 **Quick edit**
3. 修改代码
4. 点击 **Save and Deploy**

### 通过 CLI 更新

```bash
npx wrangler deploy
```

---

## 技术支持

- Cloudflare Workers 文档: https://developers.cloudflare.com/workers/
- Cloudflare Community: https://community.cloudflare.com/

---

**祝你部署顺利！** 🚀

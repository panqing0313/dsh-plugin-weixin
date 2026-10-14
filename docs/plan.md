# dsh-weixin 实施方案

## 目标

将 Hermes Agent 的 Weixin/iLink 通信适配器移植为 DSH 消息渠道插件：微信只负责消息入口/出口，DSH 负责会话、Agent、工具、权限和任务生命周期。

## 边界

### 移植到插件

- iLink 请求客户端和消息轮询；
- 绑定/登录状态管理；
- 文本、图片、文件消息的规范化；
- 发送、分段、重连、退避和限流处理；
- Weixin 会话 ID 与 DSH conversation ID 映射。

### 不移植

- Hermes Agent runtime；
- Hermes tool registry、prompt、CLI 和 session store；
- Hermes 独有的模型/权限系统。

## 目标架构

```text
Weixin/iLink -> dsh-weixin transport -> DSH Channel API
                                      -> DSH Conversation/Agent/Tools
```

插件内部按 transport、message、session、security 分层；先使用本地接口抽象，避免把未知的 DSH 私有 API 写死。

## 里程碑

1. **M0 审查**：固定 Hermes commit，核对许可证/依赖，读取 DSH 插件入口；用真实账号验证 iLink 能力。
2. **M1 文本闭环**：绑定、收文本、调用 DSH Agent、发文本；消息去重与断线恢复。
3. **M2 任务控制**：长任务状态、任务 ID、取消、长消息分段和审计。
4. **M3 安全策略**：发送者白名单、工具分级、一次性确认码、敏感输出脱敏。
5. **M4 媒体**：图片/文件/截图/diff。
6. **M5 原生 UI**：连接状态、配置、白名单、权限策略和日志。

## 关键设计

- transport 不直接执行 DSH 工具；
- sender 使用稳定用户 ID，不使用昵称做鉴权；
- 每条入站消息以 message ID 幂等；
- session 文件只留在用户本机；
- 危险动作由 DSH 权限层确认，而不是信任微信文本。

## 验收顺序

先通过单元测试验证配置、白名单、去重、会话映射，再接真实 Hermes transport；最后使用测试账号完成微信 -> DSH -> 微信闭环。当前阶段不承诺真实账号可用，因为 iLink 能力可能受账号、地区、限流和服务端策略影响。

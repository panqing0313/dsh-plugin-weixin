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

## 当前状态与后续方向（2026-10-16 更新）

M0–M5 全部达成并超出原计划：文本/媒体/语音闭环在真实账号上稳定运行；安全默认（白名单默认全拒、幂等、脱敏）落地；原生 UI 含扫码卡片、状态卡与设置卡。已发布 npm 0.2.0 并提交插件市场（等维护者合并 awesome-dsh-plugin#7426）。

里程碑之外已经完成的方向（源自对 dsh-im 的学习移植）：

- **对话体验**：忙时消息排队/插话（`busyMessageMode`、`/steer`）；超时不再丢答案（先告知、后补发，context_token 一次性约束下用 `refreshConfig()` 取新 ticket）。
- **Agent 语境**：可选 `sourceContext` 在 prompt 前附 `<weixin_source …/>` 来源块。
- **设置 UI**：真 tablist + 下载设置原子保存（暂存→保存/还原条）；同一设置卡同时挂在插件页与宿主 Settings 导航（`settings.section`，order 22）。
- **发布工程**：图标/hero 资产随包分发（manifest 引用的路径必须同时进 npm files 与安装器 COPY_ENTRIES）；desktop profile 的依赖钉在 tarball 上，发版须同步更新 package.json/package-lock.json/pnpm-lock.yaml 三处。

### 候选后续

1. **依赖源切换**：desktop profile 从 `file:…tgz` 改为 npm registry 版本号，消除「发版要同步三处清单 + /tmp tarball 备份」的负担。
2. **语音回复**：出站 TTS（SILK 编码已验证可行；注意服务端对 BOT voice_item 接受但不投递，需先验证投递路径）。
3. **发送频控自护**：约 20 条/几分钟触发账号级封锁 ≥30min——出站分片在接近阈值时主动合并/延迟。
4. **状态实时性**：GUI 状态卡在多端登录/服务端会话失效时的主动刷新（现在依赖卡片挂载与登录事件）。
5. **市场收录跟进**：PR #7426 合并后核对 dsh-market 搜索结果与条目渲染。

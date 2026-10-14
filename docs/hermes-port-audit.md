# Hermes Weixin 移植审查清单

## 已知事实（来自公开仓库资料）

Hermes Agent 有 Weixin/iLink 通道文档和 `gateway/platforms/weixin.py` 实现；公开 issue 记录过限流导致消息丢失、session reconnect、账号不支持和 prepare failed 分类问题。相关链接：

- https://hermes-agent.nousresearch.com/docs/user-guide/messaging/weixin
- https://github.com/NousResearch/hermes-agent/blob/87ad7aa0/weixin.py
- https://github.com/NousResearch/hermes-agent/issues/31131
- https://github.com/NousResearch/hermes-agent/issues/8921
- https://github.com/NousResearch/hermes-agent/issues/112709

## 在复制代码前必须完成

- [ ] 固定要移植的 Hermes commit/tag；
- [ ] 读取目标 commit 的 LICENSE 和第三方声明；
- [ ] 列出 Weixin 模块的运行时依赖；
- [ ] 确认代码是否可独立于 Hermes gateway 运行；
- [ ] 记录 iLink endpoint、请求头、轮询和退避的精确行为；
- [ ] 检查 session/二维码数据的存储和生命周期；
- [ ] 为每个复制文件保留来源和许可证注释；
- [ ] 用测试账号验证账号资格、限流和重连。

## 当前限制

本工作区没有可读取的 DSH checkout：指定的 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh` 在当前环境表现为非目录。因此本骨架暂不绑定某个 DSH 私有插件 API，等 API 源码或接口文档可见后再接入。

## 决策

先实现协议无关的领域模型和安全层，不复制 Hermes Agent runtime；避免在 DSH API 未确认前制造不可维护的耦合。

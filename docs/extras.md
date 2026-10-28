# 扩展功能：日常可用的那些开关

这一页只写**怎么用**。每一项在 `docs/progress.md` 里都有实现与取舍记录，版本号标在标题后。

## 通知桥：让脚本给你发微信（0.9.14）

长任务跑完、备份成功、cron 出错时，不用再等你主动来问：

```sh
TOKEN=$(node -p "require('$HOME/.dsh/weixin/notify.json').token")
curl -s -X POST http://127.0.0.1:47832/notify \
  -H "x-notify-token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"📦 构建完成"}'
```

- 在设置卡「配置项 → 通知桥」打开；默认关闭。
- 只绑 `127.0.0.1`，必须带 token。token 首次启动自动生成，存在 `<状态目录>/notify.json`（0600）；也可以用 `notifyToken` 自己指定。
- 纯文本也行：`curl … -d '构建完成'`。
- 每分钟最多 30 条，正文最多 4000 字（超出截断）；token 错了返回 401，发不出去返回 502。
- 推到最近说过话的那个会话；还没有任何会话时返回 502，不会静默吞掉。
- 它**不经过模型**，一条通知只花一条微信消息。

失败排查：日志里搜 `notify bridge`（端口占用）或 `notify send failed`（传输层）。

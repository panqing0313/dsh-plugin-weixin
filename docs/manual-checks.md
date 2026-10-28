# 只能在真机上确认的三件事

自动化测试跑在本机，跑不进去的部分写在这里：每条都给出「怎么试」和「看到什么算通过」，也写清楚现在**已知**的结论，免得重复踩。

## 1. 出站视频（`video/*`）

代码路径已经接好：`src/media/outbound.js` 按 MIME 分流，`video/*` 走 `sendVideoMessageWeixin`，`video_item` 带 `video_size` / `play_length` / `thumb_media`。**未做真机验证** —— 需要真实账号。

试法（在微信里让机器人做）：

```
用 ffmpeg 生成一个 2 秒 320x240 的测试视频，发给我
```

通过标准：手机收到的是一个**可以点开播放的视频气泡**，不是文件、不是封面图。

如果收到的是文件：说明 MIME 判定掉了（`.mp4` 应该没这个问题；`.mov/.mkv/.webm` 走的是 ffmpeg 转封装那条路），看日志里 `describeOutbound` 那行判成了什么类型。

## 2. 链接卡片与引用回复（`appmsg` / `refermsg`）

`vendor/openclaw-weixin/api/types.js` 的 `MessageItemType` 只有 TEXT/IMAGE/VOICE/FILE/VIDEO/TOOL_CALL_*，**没有 appmsg，也没有 refermsg**。所以：

- 收到别人分享的链接卡片 → 大概率落到「暂不支持这条消息」；
- 引用一条消息回复 → 可能被当普通文本，或者整个丢。

这条**不能靠猜**，靠观测。插件已经内置被动监听（`src/message/unknown-items.js`）：任何不认识的 item 类型、或已知 item 上出现了 `appmsg`/`refermsg`/`quote` 之类字段，都会在**每个会话第一次出现时**写一行：

```bash
grep unknown-item ~/.dsh/weixin/audit/audit-$(date +%F).jsonl
grep "unfamiliar inbound shape" ~/.dsh/weixin/logs/openclaw-$(date +%F).log
```

试法：让人给你发一张公众号链接卡片、再引用一句话回复你。然后看上面两条命令。

- 有 `item type 1 carries "appmsg"` → 服务端确实会发，值得解；
- 什么都没有 → 服务端根本没把这类消息投给 bot，不用再试。

## 3. 出站语音（已实测，结论是「不行」）

`voice_item` 能上传、`sendMessage` 返回 `ret=0`，手机**什么都不显示**。两次独立实测。所以 `voiceOutbound` 默认关闭，语音附件按文件发。这里不需要再试一次，只需要记住：不是我们没写对，是服务端不投递。

## 4. `/export` 的附件（0.9.14 起可发）

`/export 30` 在记录短于 3000 字时直接回正文；超过时写一个 `.md` 文件并发出来。文件走的是和模型回复附件完全相同的 `resolveOutboundReply`（路径必须落在 `mediaDirs` 内，exports 目录就在状态目录下），所以这里要验的是**真实上传链路**，不是路径判断（路径判断有单测）。

```bash
# 先在微信里让一个会话攒够 3000 字以上的流水（或直接改 state 目录里的 journal）
/export 30
```

- 手机收到一条消息 + 一个 `chat-<会话>-YYYY-MM-DD.md` 文件 → 附件链路通；
- 只有文字、文件躺在 `~/.dsh/weixin/exports/` → 看日志里的 `outbound media: ...` 与 `sent ... outbound media file(s)`，多半是 CDN 上传被拒（真机网络/服务端策略），不是命令本身。

## 一条经验

三条都需要**真实账号**。跑之前先 `npm run doctor`：`host app` 那行如果写着「not in the tested list」，先把宿主版本记下来 —— 真机现象和版本强相关。

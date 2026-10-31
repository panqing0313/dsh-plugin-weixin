# 宿主版本兼容表

这份插件跑在 DeepSeek Harness 桌面应用里，用的不是 npm 上的 API，而是应用自己的东西：

- `ctx.slots` 的座位名（`settings.section`、`sidebar.panellist`、`main`、`plugins.bundle.config`）
- 客户端模块加载器（`window.__ModuleLoader__`、包内 lazy chunk `require.async("./client.<name>.js")`）
- `package.json` 里的 `dsh.client` / `dsh.bundle` 块
- 两个只在宿主里存在的包：`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-llm`

这四样都没有版本号协商。宿主升级后如果座位改名、`dsh.client` 字段收紧、或者 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 换签名，插件会在运行时才出问题 —— 本机测试抓不到。

所以这张表只写**真的验证过**的组合，`npm run doctor` 会打出当前宿主版本并指出它是否在表里。

| 插件版本 | 宿主版本 | 验证到什么程度 |
| --- | --- | --- |
| `0.9.10` | `0.2.1-rc.3` | 登录、收发文字/图片/文件、设置卡九个页签、左侧栏入口、定时提醒与主动开口、备份与恢复 |
| `0.9.10` | 其它版本 | 未验证：插件会照常运行，doctor 也会说「不在测试列表里」 |

`0.9.15` 已装进本机 profile、全量自动化测试 848/848 绿；本机宿主已升到 `0.2.1-rc.5`（表里只有 `0.2.1-rc.3`），`doctor` 会标「不在测试列表」。按下一节 5 步复核通过后，再把表里那行改成 `0.9.15` / `0.2.1-rc.5`，不提前写「已验证」。

## 升级宿主之后先做什么

1. `npm run doctor` —— 看 `host app` 那一行是不是 `(tested)`。
2. 打开设置卡：九个页签都在 = 客户端 chunk 加载与座位注册没问题。
3. 看左侧栏有没有「微信」入口 = `sidebar.panellist` + `main` 两个座位还在。
4. 发一条消息让机器人回一句 = 入站轮询、allowlist、agent 桥都活着。
5. 都没问题就把宿主版本加进 `src/host-compat.js` 的 `TESTED_HOSTS`（一行），
   `docs/compatibility.md` 的表由 `compatibilityMarkdown()` 生成，不会和代码漂移。

## 已知的硬限制（与宿主版本无关）

- 微信没有给 bot 的**原生贴纸/表情包**消息类型：只能发图片气泡。
- 微信服务端**接受但不投递** bot 的出站语音（两次实测 `ret=0` 但手机无气泡）。
- node 需要 `>=22.13.0`；宿主自带的 pnpm 用来刷 profile 锁文件。

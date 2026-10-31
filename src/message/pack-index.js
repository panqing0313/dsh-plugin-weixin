/**
 * 模板包远程索引：把 `packs.indexUrl` 指向的一个 JSON 变成设置卡里可以
 * 一键安装的列表。
 *
 * 索引形状：`{ "packs": [{ "name": "温柔女友", "url": "https://…/pack.json",
 * "description": "…", "version": 1 }] }`。这个模块只负责把拿到的文本规范化
 * 成一个安全的列表 —— URL 必须是 http(s)、单包 JSON 的大小限制在
 * `MAX_PACK_JSON_CHARS`、条目数截到 `MAX_INDEX_ENTRIES`；真正的「装」仍然走
 * `importPack`，它对内容有自己的校验（格式、版本、白名单永不进包）。
 *
 * 取 URL 是「操作者自己填的地址」，与聊天里的链接抓取（有 SSRF 守卫）不同：
 * 这里的信任来源是设置卡的配置框，不是聊天消息。
 *
 * @module dsh-weixin/message/pack-index
 */

export const MAX_INDEX_ENTRIES = 50
/** 单个模板包 JSON 的大小上限 —— 人设包没有理由超过这个。 */
export const MAX_PACK_JSON_CHARS = 256 * 1024
export const PACK_INDEX_TIMEOUT_MS = 10_000

/** 索引条目只留卡片要显示与安装需要的字段。 */
export function normalizePackIndex(rawText, { warn } = {}) {
  let raw
  try {
    raw = JSON.parse(String(rawText ?? ''))
  } catch {
    warn?.('pack index is not valid JSON')
    return { packs: [] }
  }
  const list = Array.isArray(raw?.packs) ? raw.packs : []
  const packs = []
  for (const entry of list) {
    if (packs.length >= MAX_INDEX_ENTRIES) break
    const name = String(entry?.name ?? '').trim()
    const url = String(entry?.url ?? '').trim()
    if (name === '' || !/^https:\/\//.test(url)) {
      warn?.(`pack index entry skipped (need name and an https url): ${name || url}`)
      continue
    }
    packs.push({
      name,
      url,
      description: String(entry?.description ?? '').slice(0, 200),
      version: Number.isFinite(entry?.version) ? entry.version : 1,
    })
  }
  return { packs }
}

/** 一个索引条目的拉取 + 尺寸限制；内容校验交给 importPack。 */
export async function fetchPackJson(url, { fetchImpl = fetch, warn } = {}) {
  if (!/^https:\/\//.test(String(url ?? ''))) {
    throw new Error('pack url must be https')
  }
  let response
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(PACK_INDEX_TIMEOUT_MS) })
  } catch (error) {
    warn?.(`pack fetch failed: ${String(error?.message ?? error).slice(0, 120)}`)
    throw new Error('模板包拉取失败（网络或超时）')
  }
  if (!response.ok) throw new Error(`模板包地址返回 ${response.status}`)
  const text = await response.text()
  if (text.length > MAX_PACK_JSON_CHARS) throw new Error('模板包太大，超过 256KB 上限')
  return text
}
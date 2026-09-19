// difish-settings — Host 侧
//
// 除了给 dsh 设置界面提供 difish 设置页（Client 侧）之外，Host 侧还承担两件事：
//
//   1. 为 DeepSeek 官方路由注册「模型拉取」能力。
//      路由的 settings 命名空间是 "llm-deepseek"（与 dsh-llm-deepseek 的 NS 一致）。
//      dsh 自带的 dsh-llm-deepseek 只实现了 listModels()，没有调用
//      ctx.llm.registerModelDiscovery()，所以设置页里任何「获取可用模型」的
//      入口对这个路由都会以 NO_DISCOVERY 失败 —— 只能看到本地静态目录。
//      这里补上 discovery：直接问 {baseURL}/models。
//
//   2. 启动后把官方 /models 里【新增】的模型并入 llm-deepseek.models。
//      注意必须「只增不减」：本地默认目录里的图像能力（inputModalities /
//      imagePixelBudget）和 systemPromptUpdate: "in-history" 都是官方
//      /models 不会返回的字段，整体替换会把它们冲掉，反而降级。
//
// 设置里的 models 是一整个数组字段（替换语义），所以合并只能整数组写回。

export const name = 'difish-settings'

/** DeepSeek 官方路由的 settings 命名空间，必须与 dsh-llm-deepseek 的 NS 完全一致 */
const DEEPSEEK_NS = 'llm-deepseek'
/** DeepSeek 官方路由名 */
const DEEPSEEK_PROVIDER = 'deepseek-official'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
/** 响应体上限：模型列表不该很大，超了就当异常 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
/** 启动后延迟多久做一次静默同步（避开启动高峰） */
const SYNC_DELAY_MS = 6000

/** 取非空字符串，顺带 trim */
function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** 拼接模型列表地址：base 当前缀用，保留网关可能带的部署路径 */
function listingUrl(baseURL) {
  return `${String(baseURL).replace(/\/+$/, '')}/models`
}

/** 从若干候选里取第一个可用的正整数容量 */
function capacity(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  }
  return undefined
}

/** 取第一个非空字符串（用作 id / name 的兜底） */
function label(...values) {
  for (const value of values) {
    const hit = text(value)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 带上限地读取响应体，避免异常大的响应拖垮进程 */
async function readBounded(response, url) {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`${url} 响应超过 ${MAX_RESPONSE_BYTES} 字节`)
  }
  const body = await response.text()
  if (body.length > MAX_RESPONSE_BYTES) throw new Error(`${url} 响应超过 ${MAX_RESPONSE_BYTES} 字节`)
  return body
}

/**
 * 解析模型列表响应。兼容两种常见形状：
 *   - OpenAI 风格 { data: [ { id, ... } ] }（DeepSeek 官方就是这个）
 *   - 网关风格 { models: { "<id>": { ... } } }
 * 单条畸形记录跳过而不是整体失败，保证一个坏行不毁掉整份目录。
 */
function readListing(body) {
  const listing = body
  let rows
  if (Array.isArray(listing?.data)) {
    rows = listing.data.map((raw) => ({ key: undefined, raw }))
  } else if (listing?.models !== null && typeof listing?.models === 'object' && !Array.isArray(listing.models)) {
    rows = Object.entries(listing.models)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }))
  } else {
    throw new Error('模型列表响应里既没有 data 数组也没有 models 对象')
  }

  const models = []
  for (const { key, raw } of rows) {
    const entry = raw ?? {}
    const id = label(key, entry.id)
    if (id === undefined) continue
    const name = label(entry.name, entry.display_name, entry.displayName) ?? id
    const contextWindow = capacity(
      entry.contextWindow,
      entry.context_window,
      entry.context_length,
      entry.max_input_tokens,
      entry.limit?.context,
    )
    const maxTokens = capacity(
      entry.maxOutputTokens,
      entry.max_output_tokens,
      entry.maxTokens,
      entry.max_tokens,
      entry.limit?.output,
    )
    models.push({
      id,
      name,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    })
  }
  return models
}

/** 把一个拉取到的模型转成 settings 目录条目（只写有值的字段，其余交给 schema 默认值） */
function toCatalogEntry(model) {
  return {
    id: model.id,
    name: model.name ?? model.id,
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
  }
}

/** 解析 API Key：显式传入 > 凭据服务（环境变量 / 存储 / .env 都由它兜住） */
async function resolveApiKey(host, request, section) {
  const direct = text(request?.apiKey)
  if (direct !== undefined) return direct
  const ref = text(section?.apiKeyEnv) ?? DEFAULT_API_KEY_ENV
  const credentials = host.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    const value = text(hit?.value)
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * 构造 discovery：按 request（草稿）或已存设置解析端点与凭据，问一次 /models。
 * @param host 持有 llm / settings / credentials 的上下文
 */
function makeDiscovery(host) {
  return async function discover(request, signal) {
    const settings = host.get('settings')
    const section = settings?.get(DEEPSEEK_NS) ?? {}
    const baseURL = text(request?.baseURL) ?? text(section.baseURL) ?? DEFAULT_BASE_URL
    const apiKey = await resolveApiKey(host, request, section)
    if (apiKey === undefined) {
      throw new Error(`没有可用的 API Key：请先在设置里配置 ${DEFAULT_API_KEY_ENV}`)
    }
    const url = listingUrl(baseURL)
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      throw new Error(`GET ${url} 返回 HTTP ${response.status}${detail.length > 0 ? `：${detail}` : ''}`)
    }
    return readListing(JSON.parse(await readBounded(response, url)))
  }
}

export function apply(ctx, config) {
  const options = config ?? {}
  const autoSync = options.autoSync !== false

  ctx.inject(['llm'], (llmCtx) => {
    const discover = makeDiscovery(llmCtx)
    try {
      const dispose = llmCtx.llm.registerModelDiscovery(DEEPSEEK_NS, discover)
      llmCtx.effect(() => () => dispose())
      ctx.logger?.info(`difish-settings: 已为 "${DEEPSEEK_PROVIDER}"（${DEEPSEEK_NS}）注册模型拉取`)
    } catch (error) {
      // 将来 dsh 自己给这个命名空间注册了 discovery 时会走到这里：
      // 让给上游实现，不要因为重复注册而拖垮插件挂载。
      ctx.logger?.warn(`difish-settings: 注册模型拉取失败（可能已由 dsh 自身提供）：${error?.message ?? error}`)
      return
    }

    if (!autoSync) return

    const timer = setTimeout(() => {
      void syncOfficialCatalog(llmCtx, discover).catch((error) => {
        ctx.logger?.warn(`difish-settings: 同步 DeepSeek 官方模型失败：${error?.message ?? error}`)
      })
    }, SYNC_DELAY_MS)
    llmCtx.effect(() => () => clearTimeout(timer))
  })
}

/**
 * 把官方 /models 里新增的模型并入 llm-deepseek.models（只增不减）。
 * 没有新增就完全不写，避免白白把继承目录变成用户自定义。
 */
async function syncOfficialCatalog(host, discover) {
  const settings = host.get('settings')
  if (settings === undefined) return
  const models = await discover({ provider: DEEPSEEK_PROVIDER })
  if (!Array.isArray(models) || models.length === 0) return

  const section = settings.get(DEEPSEEK_NS) ?? {}
  const current = Array.isArray(section.models) ? section.models : []
  const known = new Set(current.map((model) => text(model?.id)).filter((id) => id !== undefined))
  const added = models.filter((model) => !known.has(model.id))
  if (added.length === 0) return

  await settings.update(DEEPSEEK_NS, { models: [...current, ...added.map(toCatalogEntry)] })
  host.logger?.info(
    `difish-settings: 已从官网并入 ${added.length} 个新模型：${added.map((model) => model.id).join(', ')}`,
  )
}

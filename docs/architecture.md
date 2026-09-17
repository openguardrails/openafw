# OpenAFW 架构（草案 v0.4，2026-09-14）

> 状态：设计草案；里程碑 1（透传 + 脱敏还原闭环）已实现于 `crates/`，见 §13 已验证项。本文写的是"要建成什么样"，实现落地后应改写成"现在是什么样"，
> 决策与踩坑另开 `CLAUDE.md`。

## 0. 一句话

**OpenAFW 是跑在个人开发者本机的 AI 防火墙。** 用户把 Claude Code、Codex、Gemini CLI、
OpenCode、OpenClaw、Hermes、Grok Build 指向 `http://127.0.0.1:<port>`，OpenAFW 在请求离开
本机之前把 secrets 换成占位符，在响应回到本机之后把占位符全部换回真值。模型、
中转站、模型厂商全程只见 `${OGR_SECRET_3}`；本机上的 agent、终端、文件看到的仍是真值。

**安全边界是本机的网卡**：本机是可信区，外发是不可信区。secrets 本来就是用户自己的，
用户在自己的终端里看到它不是泄露；离开本机才是。

心智模型：**Little Snitch for AI agents**。不是网关，不是路由器，不是管理平台。

## 1. 定位与非目标

| | LiteLLM | cc-switch | **OpenAFW** |
|---|---|---|---|
| 用户 | 企业平台/IT 管理员 | 个人开发者（省钱、切换） | 个人开发者（安全、可控） |
| 运行位置 | 团队共享服务器 | 本机 | 本机 |
| 核心承诺 | 统一 100+ 模型的 OpenAI 格式 | 一键切换供应商 | secrets 不出本机 |
| 协议 | OpenAI 一等，Anthropic 后加 | 各 agent 原生协议 + 互转 | 各 agent 原生协议，**只透传不互转** |
| 多租户/virtual key/DB | 有 | 无 | 无 |
| 单向脱敏 | 企业版有（detect-secrets） | 无 | 免费、双向（脱敏 + 还原） |
| UI | 管理后台 | Tauri 桌面 | 托盘 + 三页本地网页 |

**明确不做的事（v1）**：

- 协议互转（Anthropic ↔ OpenAI ↔ Gemini）。cc-switch 的 `proxy/providers/` 已经做了三十多个文件的
  转换和整流，这不是我们的战场；OpenAFW 是字节级透传，只改 JSON 字符串叶子。
- 高并发、限流、负载均衡、spend 预算。单用户，几个 agent，QPS 是个位数。
- 合规报表、审计导出、RBAC。
- 服务器部署。只有 localhost 监听，默认拒绝非回环地址。

**做，但放在 OGR 付费侧的事**：模型判定（prompt injection、工具调用出口判断）、维护中的规则源、
云端策略和仪表盘。见 §9。

## 2. 用户看到什么

安装后托盘出现一个盾牌图标。本地网页三页：

1. **首页** — 运行状态；agent 列表，每个一个 Protect / Unprotect 按钮（写该 agent 自己的配置文件，
   原文备份进 vault，与 `openafw protect` 同一条代码路径）；计数（请求数、脱敏数、还原数、未知 token）。
   活动流水只显示占位符和规则名，永远不显示值。
2. **供应商与密钥** — profile 列表（供应商 + base_url + key + 模型映射），每个 agent 当前指向
   哪个 profile，点一下切换，agent 不用重启。key 只在录入时可见一次。
3. **活动** — 请求流水：时间、agent、模型、脱敏了哪些占位符、还原了哪些、被拒绝还原的。
   点开看脱敏后的请求体（本来就是模型看到的样子）。

首次引导只有一步："保护 Claude Code" 按钮 → 写入 `~/.claude/settings.json` 的 env →
提示重开终端。其它 agent 同理。**没有配置文件需要手写。**

## 3. 总体架构

```
  ┌────────────┐ ┌───────┐ ┌────────────┐ ┌──────────┐
  │ Claude Code│ │ Codex │ │ Gemini CLI │ │ OpenCode…│      agent 本机进程
  └─────┬──────┘ └───┬───┘ └─────┬──────┘ └────┬─────┘
        │ /v1/messages│ /v1/responses│ generateContent │ /v1/chat/completions
        │  afw_ 本地 token（每个 agent 一个，用于识别与归因）
        ▼            ▼            ▼            ▼
  ┌──────────────────────────────────────────────────────────┐
  │ OpenAFW daemon   127.0.0.1:<port>                         │
  │                                                          │
  │  ingress ── 协议识别（按路径）── 认证（afw_ token → agent）│
  │     │                                                    │
  │  ┌──▼──────────── 请求路径 ────────────────────────────┐ │
  │  │ 1 已知值优先：vault 里的 key + 凭据文件里的值        │ │
  │  │ 2 规则集：ogr-re-1 正则 + reject_value 谓词          │ │
  │  │ 3 铸造 ${OGR_SECRET_n}，写 session map               │ │
  │  │ 4 替换 header 里的本地 token 为真实上游 key           │ │
  │  └──────────────────────────────────────────────────────┘ │
  │     │ 透传（保留 SSE、保留未知字段）                       │
  │  ┌──▼──────────── 响应路径 ────────────────────────────┐ │
  │  │ 5 所有字符串叶子（文本/思考/工具参数）精确整词还原     │ │
  │  │ 6 流式：只扣住可能是占位符前缀的尾巴，其余立即放行     │ │
  │  │ 7 工具参数里的未知占位符：拒绝并注入可执行的错误说明   │ │
  │  └──────────────────────────────────────────────────────┘ │
  │                                                          │
  │  vault(SQLite, 加密)   session map   活动日志   规则集缓存  │
  │  本地 UI（托盘 + http://127.0.0.1:<port>/ui）              │
  │  可选：OGR 客户端（/v1/rules, /v1/evaluate, /v1/heartbeat）│
  └──────────────┬───────────────────────────────────────────┘
                 │ HTTPS，真实 key
                 ▼
     Anthropic / OpenAI / Google / xAI / 任意中转站
```

三个进程内组件，一个可选外部依赖：

| 组件 | 职责 |
|---|---|
| **proxy** | 监听、协议识别、透传、SSE 帧处理。对 body 的唯一改动是字符串叶子替换。 |
| **engine** | 规则集加载与自检、已知值匹配、正则 + 谓词、占位符铸造与还原。纯函数，无 IO。 |
| **vault** | 上游 key、profile、session map、活动日志的加密存储。 |
| OGR runtime（可选） | 付费侧。规则源、模型判定、心跳。不可达时按 fail-open 降级。 |

## 4. 接入层

### 4.1 每个 agent 怎么指向 OpenAFW

沿用 cc-switch 已验证的"改写 agent 配置文件"方式（`cc-switch/src-tauri/src/services/proxy.rs`），
每个 agent 一个 adapter：知道配置文件在哪、改哪个字段、怎么回滚。

| agent | 协议 | 接管方式 | 备注 |
|---|---|---|---|
| Claude Code | Anthropic Messages | `~/.claude/settings.json` → `env.ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN=afw_…` | 同时覆盖 `count_tokens` |
| Codex | OpenAI Responses | `~/.codex/config.toml` → model_provider 的 `base_url` | cc-switch 用 `<proxy>/v1` |
| Gemini CLI | Gemini generateContent | `~/.gemini/.env` → `GOOGLE_GEMINI_BASE_URL`、`GEMINI_API_KEY` | 只对 API key 模式有效；Google 账号 OAuth 登录走 Code Assist 端点，不读 base URL |
| Grok Build | OpenAI 兼容 | config toml 的 base_url，cc-switch 用 `/grokbuild/v1` 前缀 | 未自动化，打印说明 |
| OpenCode | 多 provider | `~/.config/opencode/opencode.json` → `provider.<id>.options.{baseURL, apiKey}` | 已实现；id 取 profile 的 provider，透传时改 anthropic 块 |
| OpenClaw | 多 provider | `~/.openclaw/openclaw.json`（JSON5）→ `models.providers.<id>.{baseUrl, apiKey}` | 已实现；写回不保留注释，原文存 vault，`unprotect` 逐字节还原 |
| Hermes | 多 provider | `~/.hermes/config.yaml` → `model.{base_url, api_key}` | 已实现；同上 |

所有接管都先把原文件存进 vault 的 `backups`，`unprotect` 逐字节还原（含 JSON5 注释）。
**透传路由按协议选上游**：不带本地 token 的请求，Anthropic 协议去 api.anthropic.com，OpenAI 协议去 api.openai.com，
Gemini 去 generativelanguage；`--upstream` 设了就全部去那一个中转。多 provider 的 agent 因此不需要 profile 也能透传。
| Claude Desktop | 不走 API | **不接管** | 它连 claude.ai，没有 base_url 可改；cc-switch 只管它的 MCP 配置 |

**每个 agent 一个本地 token** `afw_<agent>_<random>`，写进 agent 配置代替真实 key。好处：
真实 key 不再出现在任何 agent 的配置文件里；OpenAFW 凭 token 知道是谁在调用，做归因和
per-agent 策略；换 profile 不需要动 agent。

### 4.2 协议识别

按路径前缀路由，不看 body：

| 路径 | 协议 | 工具调用在响应里的位置 |
|---|---|---|
| `/v1/messages`, `/v1/messages/count_tokens` | Anthropic | `content[].type=tool_use` → `input`；流式 `input_json_delta.partial_json` |
| `/v1/chat/completions` | OpenAI Chat | `choices[].message.tool_calls[].function.arguments`；流式 delta 同路径 |
| `/v1/responses` | OpenAI Responses | `output[].type=function_call` → `arguments`；流式 `response.function_call_arguments.delta/.done` |
| `/v1beta/models/*:generateContent`, `:streamGenerateContent` | Gemini | `candidates[].content.parts[].functionCall.args` |

协议知识**只**用于三件事：找到响应里的工具调用参数、SSE 帧边界、读 usage 和 session 提示。
请求侧脱敏是协议无关的（§5.1），所以新协议的接入成本是一个响应侧 adapter。

## 5. 请求路径：脱敏

### 5.1 扫什么

**body 里的每一个 JSON 字符串叶子**，不分字段。system、messages、tool_result、tool 定义、
metadata 全部在内。OGR local-redaction 规范原文："every string leaf"。这也是
OpenAFW 不需要理解每个协议请求 schema 的原因。

例外（跳过）：`model`、各种 id 字段、base64 媒体（长度 > 4096 且无空白的叶子按规范不当作凭据）、
已经是 `${OGR_…}` 形状的 token 内部。

### 5.2 顺序（照 OGR 1.4 local-redaction §Mask）

1. **归一化只用于匹配**：工作副本去零宽和控制字符，偏移量对原文。
2. **已知值优先，最长优先**。已知值来源三处：
   - vault 里的上游 key（用户录入的，精确值，零误报）；
   - session map 里已经铸造过的值；
   - 可选：凭据文件里的值（`~/.aws/credentials`、cwd 的 `.env`、`~/.netrc` 等，
     路径清单直接用 airs 的 `credentialFiles.ts` 的 18 个片段）。默认关，首页一个开关。
3. **规则集**：按服务顺序跑每条 ogr-re-1 规则，`group` 指定的捕获组是 span，
   `reject_value` 谓词任一命中即丢弃。重叠取最长，同长按规则顺序。
4. **原地替换，永不删除**：消息数、角色、tool id、数组下标不变。

### 5.3 占位符与 session map

占位符形状 **`OGRKFnnnnnnn`**：`OGRK` + **铸造方字母** + 七位零填充数字，共 12 字符，只有字母数字，自定界。
`F` 是 openafw，`P` 是进程内插件，`R` 是运行时；读取方一律匹配 `OGRK[A-Z][0-9X]{7}`。
**字母是必需的**：两个铸造方共用一个编号空间会让同一个 token 号指向两个不同的值，且是静默地把错误 secret
拼进工具调用（2026-09-14，airs 会话发现）。有了字母，别人的 token 对我们就是普通文本，最坏情况降级为
"一个值两个名字"，各自都能还原。同一值同一 token；`n` 在模型整个上下文里唯一。
OGR 1.4 规范的 `${OGR_SECRET_n}` 实测会被模型当成 shell 变量改写，五个模型的对比实验见
[`placeholder-experiment.md`](placeholder-experiment.md)；`${OGR_…}` 形状仍被识别（不二次匹配、可还原），
只是不再铸造。规范要求分配前扫 body 里已有的 `${OGR_SECRET_n}` 并把计数器
种到最大值之上——两个分配器（本机 + 远端 runtime）共用一个命名空间。

**map 的作用域和持久化，这里偏离规范，是有意的**：

- 规范说 map "in memory, never on disk"，理由是不要把 secrets 写进 mask 想保护的那块存储。
  但 OpenAFW 本来就是本机的密钥保险箱（§7），vault 就是"设计上该放 secrets 的地方"。
- 必须持久化的原因：Claude Code 的 autocompact 会把历史换成模型写的摘要，摘要里只有 token，
  真值从此不在任何后续请求里出现。如果 map 丢了（重启、超时），模型之后在工具调用里用
  `${OGR_SECRET_3}`，就无法还原 → 按规范必须拒绝 → 用户的任务在一次 compact 之后莫名失败。
- 所以：**一个全局 map，AES-256-GCM 加密存在 vault 里，跨会话、跨 agent、跨重启稳定。**
  值 → token 单向唯一，token 永不重绑。

全局 map 引入一个新风险：模型可以枚举它没见过的小整数 token。规范用 session 作用域堵这个口，
我们用**上下文作用域**：**响应里允许还原的 token 集合 = 这次请求 body 里出现过的 token 集合。**
模型只能合法使用它被展示过的 token；其它一律按"未知"处理（§6.2）。这条规则比 session 作用域更紧，
而且不需要识别 session。

**已决策（2026-09-13，Tom）：落盘。**

### 5.4 Prompt cache

替换是按值确定的，历史消息的脱敏结果每次相同，Anthropic 的 prefix cache 不受影响。
唯一会打散 cache 的时刻是规则集更新后历史里多了一个新命中，一次性代价，可接受。

### 5.5 上游认证

header 里的 `afw_…` 本地 token 换成 profile 的真实 key（`x-api-key` / `Authorization` /
Gemini 的 `x-goog-api-key` 或 query `key`）。body 不动。

## 6. 响应路径：还原

### 6.1 还原到哪里：全部

响应 body 里**每一个字符串叶子**都还原：文本、思考、工具调用参数、最终回答。
不区分位置，理由是 §0 的安全边界：回到本机的东西都是给用户自己看和用的。

规范（local-redaction §Restore）默认只还原工具参数、文本里保留 token，那是为"agent 进程内插件"
设计的，它的 harness 可能把最终回答投递到 Telegram / Slack。OpenAFW 的边界是本机，
所以这里**有意偏离**（§14）。残余风险只有一种：OpenClaw / Hermes 这类会把回答投递到外部
频道的 agent，投递那一步不经过 OpenAFW。v1 不处理；后续可以给这类 agent 加一个
"投递前重掩码"的 per-agent 开关（§12）。

**匹配规则**：整词精确匹配 `${OGR_SECRET_n}`，唯一容差是模型 markdown 转义出的
`${OGR\_SECRET\_1}`。不做前缀、不做模糊、不按位置猜。规范原文：猜测的还原器是一个
"exfiltration oracle"。

**一致性**：还原后的真值进入 agent 的 transcript（Claude Code 本来就存明文），下一轮作为历史
发回来时被 §5.2 第 2 步"已知值优先"换回同一个 token。模型看到的历史与它自己写的一致，
prefix cache 不受影响。

### 6.2 未知 token

出现 `${OGR_…}` 形状但不在允许集合（§5.3）的 token：

- **在文本里**：原样放行。它就是一段文本，不还原也没有危害。
- **在工具调用参数里**：**不转发该工具调用**。shell 会把 `${OGR_SECRET_7}` 展开成空串，
  调用会在下游莫名失败；转发字面量比拒绝更糟。做法是把该 `tool_use` block 的 `input`
  换成 `{"error": "…"}` 并在活动页记一条。文案照规范：

  > `${OGR_SECRET_7}` could not be restored: it is not a placeholder this session issued.
  > Placeholders must be used exactly as they appear in your context; if the value was
  > shown in an earlier session, ask the user to provide it again.

### 6.3 流式

token 会被切在两个 SSE chunk 之间，所以还原不能以 chunk 为单位；又因为文本也要还原，
不能靠"文本直接放行"来省事。方案是**扣尾**：

- 对每个正在流出的字符串（一个 text block 的 delta 序列、一个 tool_use 的 `partial_json`
  序列），维护一个小缓冲。每来一个 delta，把缓冲里**不可能是占位符前缀**的部分立即放出，
  只扣住从最后一个 `$` 开始、且仍是占位符语法合法前缀的那段尾巴（最长约 24 字节：
  `${OGR_SECRET_` + 数字 + `}`，加上 `\_` 转义变体）。
- 没有 `$` 的 delta 零延迟。有 `$` 的 delta 最多扣住二十几个字节，等下一个 delta 或
  block 结束再放。用户看不出来。
- block 结束（`content_block_stop` / `arguments.done` / 流结束）时把缓冲清空放出。
- **JSON 转义**：`${OGR_SECRET_n}` 本身不含需要 JSON 转义的字符，可以直接在 `partial_json`
  的原始文本上匹配；但**替换进去的真值必须做 JSON 字符串转义**（引号、反斜杠、控制字符），
  否则一个含 `"` 的密码会打坏 agent 的增量 JSON 解析。非流式的完整 body 走解析后的叶子替换，
  不存在这个问题。
- 非文本帧（`message_start`、`ping`、usage、`content_block_start`）原样转发，不解析。

各协议的流式字段：

| 协议 | 文本 | 工具参数 |
|---|---|---|
| Anthropic | `content_block_delta.delta.text` / `thinking` | `content_block_delta.delta.partial_json` |
| OpenAI Chat | `choices[].delta.content` / `reasoning_content` | `choices[].delta.tool_calls[].function.arguments` |
| OpenAI Responses | `response.output_text.delta` | `response.function_call_arguments.delta` |
| Gemini | `candidates[].content.parts[].text` | `parts[].functionCall.args`（整块到达） |

## 7. Key vault 与 profile

- **profile** = `{name, provider, base_url, api_key, model_map?, headers?}`。一个 agent 的一条
  路由指向一个 profile。切换 = 改指针，热生效，agent 不重启。这部分对标 cc-switch 的
  "供应商切换"，但真实 key 只在 vault 里。
- **加密**：单个 vault 文件，AES-256-GCM；主密钥是 `~/.openafw/master.key`（32 字节随机，0600），
  三平台同一条代码路径，不依赖 OS 钥匙串（Tom 2026-09-14：钥匙串在无头会话里会不可用，且三平台行为不一）。
  加密买到的是：vault 文件被拷走或进备份后，没有旁边的 key 文件就没用。可选 `AFW_MASTER_KEY` 覆盖。
- vault 里的 key 同时是 §5.2 的"已知值"——用户录进来的 key 如果出现在任何 prompt 里
  （比如 agent 读了 `~/.claude/settings.json`），一定会被脱敏，不靠正则。
- 导入：识别 cc-switch 的配置格式做一键导入，降低迁移成本。

## 8. 规则引擎：从 airs 拿什么

引擎源码在 `openguardrails-airs/packages/shared/src/policy-engine/`。规则**数据**直接复用，
**代码**按下表取舍：

| 拿 | 文件 | 说明 |
|---|---|---|
| ✅ 规则集数据 | `entities.ts` 的 `SECRET_CHECKS`，经 `secretRuleset.ts:composeSecretRuleset` 输出 | 10 条规则、`entity_api_key` 下 30 个 issuer 模式，含 `group`、`reject_value`、`examples` 。作为 OpenAFW 内置规则集快照打包，形状就是 `GET /v1/rules` 的 wire 形状 |
| ✅ 谓词语义 | `valuePredicates.ts` | 7 个 kind（placeholder / secret_noun / variable_reference / names_secret / structural / low_entropy / matches）+ 3 个 part 选择器。闭合词汇表，规范要求每个集成必须实现，逐条移植 |
| ✅ 自检 | 每条规则的 `examples.match/nomatch` | 加载时跑，失败的规则按 id 禁用并记日志。规范硬性要求，也是移植正确性的免费测试 |
| ✅ 占位符 | `redact.ts` 的形状与 `occupiedPlaceholders` | `${OGR_SECRET_n}` 与计数器种子规则 |
| ✅ 凭据文件清单 | `credentialFiles.ts:DEFAULT_CREDENTIAL_FILE_PATTERNS` | 作为 §5.2 可选已知值来源的文件路径清单 |
| ✅ 规则集缓存语义 | `secretRulesetStore.ts` 的 `If-None-Match` / 304 / 失败回退缓存 | 见 §9 |
| ❌ PII 规则与 refutation | `entityRefutation.ts`、PII 部分 | 规范明确 PII 不做本地脱敏（有语义，脱了模型就不会用了） |
| ❌ 正则线程池 | `regexPool.ts` | 为 4MB 事件的尾延迟和 kill switch 设计；本机请求体一般 < 200KB，airs 实测 16KB 用 9ms |
| ❌ whitelist / tuning / decisionTrace / egressMask / vaultStore | | 都是多租户平台的东西。airs 的 `vault.ts` 不是密钥保险箱，是入库脱敏，和 §7 的 vault 同名不同物 |

**airs 的两条硬教训要带过来**：

1. `reject_value` 是规则的一部分，不是可选的后处理。只跑 pattern 不跑谓词 = 跑了一条不同的规则，
   会在 nomatch 样例上失败并自禁——airs 曾因此在每台主机上静默禁掉了最重要的三条规则
   （密码赋值、URL userinfo、数据库连接串）。
2. 无法求值的谓词（未知 kind、引擎不接受的 `matches`）→ **禁用该规则**，绝不当作"无过滤"。

**正则方言 ogr-re-1，模式字节级照搬，不重写**：方言是 V8 与 CPython `re` 的交集，用了定宽
lookbehind、无 `\b`。airs 的这套模式是在真实流量上调过性能的（`entity_email` 去掉前导 guard
后 200KB 要 22.6s；有 guard 后 16KB 9ms），**正则本身的快慢比实现语言的快慢重要一个数量级以上**，
所以：

- 模式源串与 airs 逐字相同，用 `GET /v1/rules` 的 wire 形状（`boundary` guard 已由
  `ruleFromCheck` 内联进 source）。不"顺手优化"。
- Rust 用 `fancy-regex`：无 lookaround 的模式它自动委托给线性时间的 `regex` crate，有 lookbehind
  的走回溯引擎。这和 airs 的 `compileLinear`（能 RE2 就 RE2，否则 V8）是同一策略。Go 的 RE2
  不支持 lookbehind，出局。
- **移植验收两道门**：① 每条规则的 `examples.match/nomatch` 全过（加载时也跑，失败按 id 禁用）；
  ② 性能基准：用一份 16KB / 200KB / 1MB 的混合语料对比 airs 的数字（16KB ≈ 9ms），任何一条
  规则在 Rust 引擎下出现超线性增长就是回溯语义差异，回到 airs 改模式，而不是在 Rust 侧改。
- 方言以后若要扩展（比如新谓词），改的是 OGR 协议本身，协议是开源中立的，两边同步。

## 9. OGR 接入（免费 vs 付费）

OpenAFW 开源免费，本身完整可用。连上 OpenGuardrails（输入一个 `ogr_` 组织 key）后解锁付费能力。
接口全部是已有的 OGR runtime-api，OpenAFW 就是一个规范意义上的 integration：

| 能力 | 免费（离线） | 连接 OGR 后 |
|---|---|---|
| secrets 脱敏还原 | 内置规则集快照 | `GET /v1/rules` 拉取组织规则集，覆盖内置；`If-None-Match` 增量；心跳带回规则 id 变更 |
| 判定 | 无 | 每步 `POST /v1/evaluate`（已实现）：请求前 `step/request` 判脱敏后的请求体，响应后 `step/response` 判完整回复（流式先重组）。默认**只观察**，裁决和 findings 记到活动页；`--ogr-enforce` 后 `block` 生效：请求前拦下不调模型，响应侧整流扣住（head = 0）判完再放行或以协议错误帧拒绝。Gemini 暂不上报（OGR 的 `llm_protocol` 没有它，要先转 canonical）。运行时若是早于铸造方字母 schema 的旧部署、不认 `redaction.masked` 里的 token 形状，去掉该字段重发一次，步骤照判（当前运行时接受 `OGRK[0-9A-Z][0-9X]{7,}`，不会走这条路）。 |
| 仪表盘 | 本地活动页 | 云端会话视图、`redaction.masked[]` 报告带来的漏报诊断（stale / miss / uncovered） |
| 策略 | 本地开关 | 组织策略下发 |

**vantage 说明**：规范把 local-redaction 限定在"agent 进程内的集成"，并说"网关路径上不做"，
理由是网关处 secret 已经离开主机。OpenAFW 是**本机**网关，secret 尚未离开主机，所以它处在
local-redaction 的 vantage，按 integration 行为对接，不按 gateway 行为。发给 OGR 的每个事件
都先过同一个 map（规范：the OGR client is an egress too）。

**降级**：OGR 不可达 → 用缓存规则集，继续脱敏，判定 fail-open（活动页标 unjudged），首页显示"未连接"。
每次 evaluate 有 `--ogr-timeout-ms`（默认 4000）预算。PII 的 `modifications.spans` 按路径和码点偏移套用到出站体，
并把替换对记进本响应的还原键，回到本机时 `${OGR_EMAIL_1}` 也还原（§6.1 全还原）。
从未拉到规则集 → 内置快照，`redaction.ruleset` 报空串。永远不因为云端不可达而阻断用户的 agent。

**一个要拍板的地方**：规范说 `/v1/rules` 的存在是为了"开源插件不自带规则"。OpenAFW 作为免费产品
如果不自带规则，等于免费版什么都不保护。建议**自带快照**：付费价值在维护中的规则源、模型判定和
诊断，不在这十条正则。

## 10. 威胁模型与存储

**防的是谁**：模型厂商、中转站、以及它们之间的任何链路。**本机是可信区**：用户自己的磁盘、
终端、agent 进程都不在威胁模型内——本机磁盘上本来就有 `~/.aws/credentials` 和 Claude Code 的
明文 transcript，用户在终端里看到自己的 secret 不是泄露。

**因此**：
- vault 加密是防"电脑被借走 / 备份泄露"这一档，不是防本机 root。
- session map 落盘可以接受（§5.3）。
- 活动日志**永远不写值**，只写占位符、规则 id、agent、时间。这是 airs 的 egressMask 原则的
  本机版：日志的安全性等于检测的安全性，所以日志只记 token。

**不防的**：用户把 agent 直接指回厂商，绕开 OpenAFW。这是个人工具，不是管控。

## 10.5 形态：守护进程、服务、桌面壳（2026-09-14 决定）

三平台一份核心：`crates/openafw` 是库（`build_state` / `serve_state`）加 CLI。三种运行形态都跑同一段逻辑：

| 形态 | 实现 | 平台 |
|---|---|---|
| 终端里 `openafw` | CLI | 三平台 |
| 常驻服务 `openafw service install` | macOS launchd 用户代理（`~/Library/LaunchAgents/com.openguardrails.openafw.plist`）；Linux systemd user unit（`~/.config/systemd/user/openafw.service`）；Windows 计划任务（`schtasks /SC ONLOGON`） | 三平台，`uninstall` 完全复原 |
| 桌面壳 `openafw-desktop` | Tauri 2：托盘（打开 / 暂停保护 / 退出）+ 一个窗口，窗口里就是本地状态页 `/__afw/`，守护进程在同一进程里跑；若服务已在监听则只附着不再起第二个 | macOS、Windows 为主；Linux 桌面版随同一套代码顺手产出（WebKitGTK + libappindicator），作为 best-effort 产物，Linux 主路径是 CLI + systemd |

**一键接管**：状态页的 Protect 按钮调 `POST /__afw/api/protect`，`GET /__afw/api/agents` 给出每个 agent 的
名称、配置文件路径和当前是否指向本机（按配置文件里是否出现监听地址判断）。没有 profile 时按钮仍可用，
agent 保留自己的凭据，照样脱敏。

**暂停**（`POST /__afw/api/pause`，托盘和状态页都有）= 请求原样透传、不脱敏。这是调试态：状态页整条红色横幅，
日志 WARN，永远不是默认。Tom：Linux 用户多在终端和远程机器上，桌面 webview 是最容易出问题的一层，不作主路径。

## 11. 技术栈建议

**已决策（2026-09-13，Tom）：Rust 单二进制 daemon + 托盘，UI 是内嵌的本地静态网页。**
约束：正则格式与 airs 一致或兼容（§8）。

- 用户的痛点之一是"litellm 不轻"。Rust daemon 常驻内存 ~20MB，启动毫秒级；cc-switch
  证明了这个受众接受 Rust + Tauri。
- 谓词词汇表是闭合的、有界的、带样例的，规范就是为"每个集成自己实现"设计的，移植成本可控。
- 正则用 `fancy-regex`（lookbehind）。加载时跑 examples 自检，等于免费的移植回归测试。
- SSE 用 `hyper` 直通，不经过任何 JSON 反序列化就能转发非工具帧。

TypeScript 方案（直接 import airs 的 `valuePredicates.ts`）只保留为一次性实验工具：
验证占位符被模型复述的行为、生成性能基准的参照数字。不进交付代码。

## 12. 后续能长出来的东西

都在同一个位置（本机、每个请求和响应都经过）自然延伸，不改架构：

- 工具调用出口控制：`curl` 到未知 host 且参数含 token → 本机弹窗批准（连 OGR 后由 evaluate 判定）。
- tool_result 注入检测：网页 / 文件内容里的指令注入（付费，模型检查）。
- 用量与成本：从 usage 字段直接读，按 agent / profile 汇总，对标 cc-switch 的用量面板。
- 一键熔断：托盘 "Pause all agents"。
- 本机 MCP server 出口：同样的脱敏管道套在 MCP 请求上。
- 本机铸造接口 `POST /__afw/api/mask`（已实现）：其它本机进程（OGR 插件、hooks）把要外发的文本或 JSON 交给
  openafw 脱敏，走同一张 map 和同一套规则。**只有 value→token，没有 token→value**：还原只发生在持有回复的
  那个进程里，否则任何本机进程都能拿到会话里所有 secret 的明文（与 airs 会话约定，2026-09-14）。
- 投递前重掩码：对会把回答发到 Telegram / Slack 的 agent（OpenClaw、Hermes），按 agent 开一个
  "最终回答保留 token"的开关，覆盖 §6.1 的全还原默认。

## 13. 待验证 / 待决策

**已验证（2026-09-14，里程碑 1，Claude Code 2.1 + Sonnet 经本机代理）**：
1. 端到端闭环成立。请求里 `sk-proj-…`（44 字符）被 `entity_api_key/openai` 换成
   `${OGR_SECRET_1}`；模型在 Bash 参数里原样写回 token；OpenAFW 在 `input_json_delta`
   流里还原；shell 量出 44。模型全程只见 15 字符的占位符。
2. 占位符形状：`${OGR_SECRET_1}` 被 Sonnet 当成 shell 变量改写为 `$OGR_SECRET_1`。跨 DeepSeek ×2、
   Qwen3.8、Claude Code、Codex 三轮对比实验后改为 **`OGRKnnnnnnnn`**：五个模型零改写、零环境变量化，
   不需要任何系统提示说明。详见 `placeholder-experiment.md`。用新格式再做端到端：两个 secret
   （GitHub、Stripe）被脱敏，模型经 Bash 写进文件，文件里是真值，日志里只有占位符。
3. 当用户提示本身像"把密钥打印回来"时，模型会拒绝（它把占位符当成真实凭据对待，反而说明
   mask 是透明的）。正常任务不受影响。
4. 扣尾流式：文本 delta 里被切开的 token 正确还原；扣住的 `$` 在 `content_block_stop`
   之前作为独立 delta 放出。Claude Code 无感。
5. airs 的 10 条规则在 fancy-regex 下全部通过自带 examples，OGR conformance 语料
   （mask 10 / restore 9 / stream 7）全过。
6. 性能（release，混合语料，密集 secrets）：16KB 18ms，200KB 227ms，1MB 993ms，4MB 2.2s。
   线性增长，没有超线性的规则。绝对值比 airs 的 V8 数字慢约 2 倍（16KB 9ms），
   `entity_api_key`（33 个 issuer 模式，每个带 lookbehind）占 2/3。两条不改模式的路：
   ① 按叶子缓存脱敏结果（每轮重发的历史几乎免费），② 像 airs 对 RE2 那样把首尾
   boundary guard 提出来在代码里判，核心模式走线性引擎。

8. **OGR 接入端到端**（2026-09-14，本机 airs 开发栈 127.0.0.1:3000）：`connect` 拉到服务端规则集（id 与内置相同），
   Claude Code 跑一个任务产生 5 次模型调用，11 个 evaluate 事件全部得到裁决（含一次去掉 redaction 的重发），
   心跳健康，活动页每条显示 req/resp 两个 decision。
7. **泄露路径演示**（2026-09-14，`--tap` 落盘发往上游的请求体）：让 Claude Code 修 `.env` 里一行格式错误，
   文件里有一个 Stripe key。无 openafw：5 个请求里 2 个带真 key（Read 的 tool_result 和下一轮重发的历史）；
   有 openafw：4 个请求 0 个带真 key，2 个带 `OGRK00000001`。本地文件和终端里的回答都是真值。
   这就是最常见的泄露路径：不是用户贴 key，而是 agent 顺手读了含 key 的文件，之后每轮都重发。

**待验证**：
1. Codex / OpenCode / Gemini CLI 的接管字段与实际流量形状。
2. 各 agent 如何在请求里带 session 信息（Claude Code 的 `metadata.user_id` 是 JSON 串，
   含 `session_id`；Codex 是 `prompt_cache_key`）。上下文作用域还原不依赖它，OGR 事件报告需要。
3. Gemini 对占位符的复述保真度（GPT 系经 Codex 已测）。

**已拍板（2026-09-13，Tom）**：
1. session map 加密落盘（§5.3）。
2. 免费版自带规则集快照（§9）。
3. Rust，正则格式与 airs 一致或兼容（§8、§11）。
4. 占位符沿用 `OGR_` 前缀；OpenAFW 用 OpenGuardrails 协议做安全功能，需要时改协议本身，
   协议开源中立。
5. 响应回到本机全部还原，不区分文本与工具参数（§6.1）。

## 14. 与 OGR 1.4 local-redaction 规范的偏离清单

| 条款 | 规范 | OpenAFW | 理由 |
|---|---|---|---|
| map 存储 | 内存，不落盘 | 加密落盘 | compact 后真值不再出现在请求里（§5.3） |
| map 作用域 | per session | 全局 + 上下文作用域还原 | 不依赖 session 识别；更紧（§5.3） |
| vantage | 进程内集成 | 本机网关 | secret 未离开主机，实质等价（§9） |
| 规则来源 | 只从 `/v1/rules` | 内置快照 + `/v1/rules` 覆盖 | 免费版要能保护（§9） |
| 还原范围 | 只进工具参数，文本保留 token | 响应里全部叶子 | 本机是可信区；用户看到自己的 secret 不是泄露（§6.1） |
| 未知 token 的拒绝 | 不转发该工具调用 | 工具参数：替换 input 为错误对象；文本：放行 | 透传架构里能做的最接近形式（§6.2） |
| secrets 占位符形状 | `${OGR_SECRET_n}` | `OGRKFnnnnnnn`（带铸造方字母） | 实测规范形状被模型当成变量改写；见 placeholder-experiment.md |

其余条款（占位符形状、已知值优先、最长优先、不在 token 内匹配、原地替换、`reject_value` 必须求值、
examples 自检、整词精确、工具参数里未知 token 即拒绝、发往 runtime 的事件先过 map）全部照办。
偏离项如果值得成为协议的一部分（比如"本机网关 vantage"、"可信区全还原"），走 OGR 协议仓的
proposals 流程改协议，而不是长期停留在偏离清单里。

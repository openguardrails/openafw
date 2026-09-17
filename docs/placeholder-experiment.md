# 占位符格式实验（2026-09-14）

问题：模型会不会把脱敏占位符改写？`${OGR_SECRET_1}` 在 Claude Code 里被当成 shell 变量。
我们不能要求用户在系统提示里解释占位符，所以占位符必须自己"长得对"。

## 方法

8 种写法 × 4 个真实任务 × 每模型 1–3 次采样，单轮，给模型一个 `run_shell` 工具，
看第一轮工具调用参数里占位符是否**逐字**出现。脚本在 `scripts/ph_*.py`。

任务：S1 用 token 做 bearer 头 curl；S2 追加 `STRIPE_KEY=<值>` 到 `.env`；S3 用 token 克隆私有仓库；
S4 写一个带 Authorization 头的 Python 脚本并运行。

评分：`verbatim` 逐字出现在工具参数里；`envvar_use` 被当环境变量（`$X`、`${X:-}`、`os.environ[...]`）；
`mutated` 其它改写；`precheck` 第一轮只做了探查命令（不算格式失败）；`refused` 拒绝。

## 结果（5 个模型配置合计，n=44/格式）

| 写法 | 例子 | verbatim | envvar_use | mutated | precheck | refused | verbatim% |
|---|---|---|---|---|---|---|---|
| `${OGR_…}` | `${OGR_SECRET_1}` | 19 | 22 | 0 | 1 | 1 | 43% |
| 凭据 ID | `OGRK00000001` | 39 | 0 | 0 | 4 | 1 | 89% |
| **连字符** | **`OGR-SECRET-1`** | **41** | **0** | **0** | 2 | 0 | **93%** |
| 尖括号 | `<OGR_SECRET_1>` | 20 | 12 | 9 | 1 | 0 | 45% |
| 双方括号 | `[[OGR_SECRET_1]]` | 22 | 10 | 4 | 6 | 0 | 50% |
| 双花括号 | `{{OGR_SECRET_1}}` | 20 | 9 | 11 | 1 | 0 | 45% |
| key 形状 | `sk-ogr-1-Xk7Q…` | 39 | 0 | 0 | 3 | 2 | 89% |
| URI | `ogr://secret/1` | 29 | 0 | 9 | 2 | 0 | 66% |

分模型（verbatim / n）：

| 写法 | deepseek-flash | deepseek-v4-pro | qwen3.8-27b | Claude Code (Sonnet) | Codex |
|---|---|---|---|---|---|
| `${OGR_SECRET_1}` | 3/12 | 7/12 | 7/12 | 2/4 | 2/4 |
| `OGRK00000001` | 10/12 | 12/12 | 11/12 | 3/4 | 3/4 |
| `OGR-SECRET-1` | 10/12 | 12/12 | 12/12 | 4/4 | 3/4 |
| `<OGR_SECRET_1>` | 7/12 | 2/12 | 6/12 | 2/4 | 3/4 |
| `[[OGR_SECRET_1]]` | 8/12 | 5/12 | 4/12 | 2/4 | 3/4 |
| `{{OGR_SECRET_1}}` | 10/12 | 7/12 | 0/12 | 0/4 | 3/4 |
| `sk-ogr-1-…` | 12/12 | 12/12 | 10/12 | 2/4 | 3/4 |
| `ogr://secret/1` | 7/12 | 9/12 | 9/12 | 2/4 | 2/4 |

## 观察

1. **决定因素是"像不像标识符"，不是外面套什么。** 只要核心是 `OGR_SECRET_1` 这种大写下划线，
   `${}`、`<>`、`[[]]`、`{{}}` 都会被读成环境变量或模板变量：DeepSeek 写 `os.environ.get("OGR_SECRET_1")`，
   Codex 写 `if [[ -z "${OGR_SECRET_1:-}" ]]`，Claude Code 直接说"这是未填充的模板占位符"然后拒绝。
2. **像"值"的写法全部原样复制。** `OGR-SECRET-1` 和 `OGRK00000001` 在五个模型上零改写、零环境变量化。
   非 verbatim 的样本都是模型先跑了探查命令（`ls .env`、`git --version`），单轮实验截住了。
3. **伪造凭据形状不可取。** `sk-ogr-…` 复制率高，但 Claude Code 会质疑"GitHub token 应该是 `ghp_` 前缀，
   `sk-` 不像"。模型知道各家 key 的前缀，我们不可能对每种 secret 伪造对的形状。它还会撞上我们自己的
   `entity_api_key/openai` 规则。
4. `ogr://secret/1` 被当作密钥管理器引用：DeepSeek 去 `command -v ogr`，Claude Code 说"这是引用不是值"。
5. `OGR-SECRET-1` 相比 `OGRK00000001` 的额外好处：人看日志一眼能懂；连字符在 markdown 里不需要转义
   （下划线会被转义成 `\_`，规范为此专门写了容差）。代价是它**不自带定界符**：`OGR-SECRET-1` 是
   `OGR-SECRET-12` 的前缀，还原器必须检查左右边界（字母数字和连字符都不能相邻），流式下 token 恰好
   落在 delta 末尾时要扣住等下一个 delta。引擎已实现并有测试。

## 第二轮：固定宽度 vs 变宽

airs 侧提出：不自带定界符的 token 要求每个还原器（Go、Python、TS、Rust）都实现同一条边界规则，
而固定宽度天然自定界，还原器可以保持"整键精确匹配、最长优先、别的什么都不做"。
所以再比一次 `OGR-SECRET-1` 和 `OGR-SECRET-000001`，API 模型每种 52 样本，harness 每种 12 样本：

| 模型 | `OGR-SECRET-1` | `OGR-SECRET-000001` |
|---|---|---|
| deepseek-flash | 47/52 | 42/52 |
| deepseek-v4-pro | 50/52 | 52/52 |
| qwen3.8-27b | 48/52 | 47/52 |
| Claude Code (Sonnet) | 10/12 | 8/12 |
| Codex | 10/12 | 9/12 |

没有任何样本改动过数字（不丢前导零、不重编号）。所有非逐字样本都是探查命令或对场景本身的拒绝
（`api.example.com` 是保留域名；"token 不该放进 clone URL"），两种形状各有。Claude Code 在 S1 场景里
对两种形状都说"OGR-SECRET 前缀加顺序编号像 canary/honeytoken"，然后拒绝往 example.com 发；
其它三个场景全部照做。DeepSeek 有一例主动 `sed 's/OGR-SECRET-[A-Za-z0-9]*/***REDACTED***/g'`
把 token 从命令输出里遮掉，把它当真凭据对待。

## 第三轮：伪造真 key 形状？外发场景、真实域名、真 key 基线（Claude Code 为主）

Tom 提出：模型知道各家 key 的前缀，能否保留前缀（`sk-`、`ghp_`、`AKIA`）接 `ogr` 开头的随机值，让占位符像真 key？
并重新定义了目标：**模型对脱敏后 key 的处理要与对真 key 一致**，而且 key 更多来自 agent 读到的文件和配置任务，
要防的是 key 进入发往模型厂商和中转站的请求。

### 3a. 外发场景（真实域名：api.github.com、api.openai.com、api.stripe.com、内部服务），Claude Code Sonnet

| 写法 | GitHub | OpenAI | Stripe | 内部 | 合计（去掉 Stripe） |
|---|---|---|---|---|---|
| 真 key，无防火墙（基线） | 0/3 | 0/3 | 0/3 | 0/3 | **0/9** |
| 发行方前缀伪造 key（`ghp_ogr000001…`、`sk-proj-ogr…`、`sk_live_ogr…`） | 0/3 | 0/3 | 0/3 | 1/3 | 1/9 |
| `OGR-SECRET-000001` | 3/3 | 0/3 | 0/3 | 0/3 | 3/9 |
| `OGR-000001-K7Q2M9` | 3/3 | 3/3 | 0/3 | 0/3 | 23/36（含决胜轮） |
| `OGR-K7Q2M9-000001` | 5/6 | 5/6 | 0/3 | 1/6 | 19/27 |
| **`OGRK00000001`** | 6/6 | 5/6 | 0/3 | 3/6 | **21/27** |

拒绝原文分三类：（1）真 key 和伪造 key："这是一个真实的 GitHub PAT / 你把 live key 贴进了对话，即使发给
Stripe 自己的 API 也会进日志，建议轮换"——**Claude Code 对贴进对话的真 key 一律不肯外发**；伪造得越像，
触发得越准。（2）`OGR-SECRET-000001`："OGR-SECRET 前缀加顺序编号像 canary/honeytoken"。（3）中性写法：
"这不是 Stripe key 的格式（应为 sk_live_）"、"api.acme-corp.com 不是我能验证的域名"——后者与写法无关。
Stripe 一列任何写法都是 0，Claude Code 原话"即使是真 key 我也不建议用 curl 传"。

DeepSeek v4-pro 在同一批场景下所有写法 96/96；Qwen 各写法一致（差异全是探查命令）；Codex 有效写法全部 8/8（`OGRK` 那组额度恢复后补跑 8/8）。伪造 key 在它们身上没有任何提升。

### 3b. 本机配置任务，key 来自文件（Claude Code Sonnet，每格 3 样本）

任务：`.env` 里的 Stripe key 写进 `config/production.yml`；`creds.txt` 里的 AWS 凭据跑 `aws configure set`；
`token.txt` 里的 GitHub token 配 git remote；`notes.txt` 里的 OpenAI key 写进 `.env`。
评分看工具调用参数和落盘文件里是否逐字用了这个值。

| 写法 | Stripe yml | AWS CLI | git remote | OpenAI .env | 合计 |
|---|---|---|---|---|---|
| 真 key | 3/3 | 3/3 | 3/3 | 3/3 | 12/12 |
| 发行方前缀伪造 key | 3/3 | 3/3 | 1/3 | 3/3 | 10/12 |
| `OGRK00000001` | 3/3 | 3/3 | 3/3 | 2/3 | 11/12 |
| `OGR-SECRET-000001` | 3/3 | 3/3 | 3/3 | 3/3 | 12/12 |

非逐字的样本：伪造 key 两次先提醒"token 会明文进 `.git/config`"（和真 key 同样的卫生提示），OGRK 一次是
"找不到 ingest service 目录"（任务描述问题）。**在 key 来自文件的本机任务里，所有值形状的占位符和真 key
行为一致，没有任何拒绝或改写。**

### 3c. 泄露路径演示（`--tap`）

让 Claude Code 修 `.env` 里一行格式错误，文件里有 Stripe key。无 openafw：5 个发往 Anthropic 的请求里 2 个含真 key
（Read 的 tool_result 和下一轮重发的历史）；有 openafw：4 个请求 0 个含真 key，2 个含 `OGRK00000001`。
本地文件和终端里的回答都是真值。另外两个观察：让它"把 key 写进 config 并打印"它直接拒绝并建议用 `${VAR}` 引用；
让它用 `token.txt` 配 git remote，它写的是 `$(cat token.txt)`，token 全程没进上下文。Claude Code 自己会尽量不让
secret 进对话，但"顺手读文件"这条它挡不住。

### 3d. 为什么不用伪造真 key 形状

1. 本机任务上没有收益（10/12 对 11–12/12）；外发场景上最差（1/9），因为它精确触发"贴进对话的 live key 不外发"。
2. 模型知道各家 key 的前缀和长度；通用规则（bearer、password、URL 凭据）抓到的值不知道发行方，配错前缀就撞上
   "GitHub token 应该是 ghp_ 不是 sk-"。
3. 我们自己的规则会匹配我们的占位符；中转站和厂商侧的密钥扫描器会把它们当真泄露；OGR 判定端失去可读性。

## 第四轮：写代码时要不要模拟发行方前缀（`hf_`、`sk-`、`ghp_`）

Tom 的顾虑：写一段向 Hugging Face 上传模型的代码，token 不是 `hf_` 开头，模型会不会发现问题？
前提先说清：本地 SDK 和 CLI 永远看不到占位符，还原发生在执行之前；问题只在模型自己的判断。

任务：huggingface_hub 上传、openai SDK、GitHub REST（requests）、boto3 上传，各要求"把 token 显式传进去"并做语法检查；
token 分别来自文件和提示。写法：真 key、全长伪造 key（`hf_ogr000001…`）、`OGRK00000001`、`hf_OGRK00000001`、
前缀 + 标记补足到真实长度。评分除了"值是否进了代码"，还专门记录模型是否对**格式**提出质疑。

Claude Code Sonnet，每格 2 样本，16 次/写法：

| 写法 | 悄悄照用 | 用了但提醒轮换 | 写了代码但不硬编码值 | 改写 | 格式质疑 |
|---|---|---|---|---|---|
| 真 key | 0 | 2 | 12 | 2 | 0（1 次『这像一个 live PAT』，是对真实性的判断，不是格式） |
| 全长伪造 key | 1 | 1 | 14 | 0 | 0（1 次同上） |
| `OGRK00000001` | 2 | 1 | 13 | 0 | 0 |
| `hf_OGRK00000001` | 2 | 0 | 14 | 0 | 0 |
| 前缀 + 标记补足长度 | 1 | 1 | 14 | 0 | 0 |

Codex（每格 1 样本）：token 在提示里，五种写法都 4/4 硬编码；token 在文件里，五种写法都改成运行时读文件。无质疑。

结论：**写代码时模型不检查前缀**，五种写法零格式质疑；Claude Code 对任何凭据（含真 key）都拒绝硬编码进源码，
改成读文件或环境变量，并提醒轮换贴进对话的 key——这是它的编码习惯，与占位符无关。模拟前缀既无收益，
又带来 §3d 的全部成本。之前看到的格式质疑只出现在"把贴进对话的 key 用 curl 发给发行方"的场景。
如果将来某个具体 issuer 上出现格式质疑，可以在规则集里给该 issuer 模式加一个可选的 `placeholder` 模板字段，
其余保持 `OGRK`；工程上可行，目前没有数据支持这样做。

## 第五轮：铸造方命名空间（2026-09-14 晚）

不是外观问题，是 airs 会话发现的一个真 bug：**两个铸造方共用一个编号空间，会静默地把错误的 secret 拼进工具调用**。
本机计数器按主机、永久；运行时计数器按 agent、7 天过期；`occupiedPlaceholders` 的下限只看得见当前这个 body。
于是：会话 A 本机铸造 1 号 → X；会话 B 同一个 agent、body 里没有本机 token，下限为 0，运行时也铸造 1 号 → Y。
回到会话 A，body 里的 1 号是 X，运行时注册表里的 1 号是 Y，并把明文 Y 也重掩码成 1 号。一个上下文里一个 token 两个值，
哪一边还原都可能拼错，而且不抛任何错。

Tom 批准的解法：**`OGRK` + 一个铸造方字母 + 7 位数字**，宽度仍是 12。`F` = openafw，`P` = 进程内插件，`R` = 运行时。
溢出 token 相应为 `OGRKFXXXXXXX`。读取方一律匹配 `OGRK[A-Z][0-9X]{7}`，将来加第四个铸造方不用改任何正则
（CI 在协议仓里就找出 5 处、airs 里 8 处 token 正则副本）。

schema 上的两个细节：位置五要写 `[0-9A-Z]`（容忍无字母那一天里产出的生产方），运行部分要写 `[0-9X]`——
溢出 token（`OGRKFXXXXXXX`）是 fresh 的，会进 `masked[]`，只写 `[0-9]` 会把一次成功的脱敏变成 400。

买到的是：下限和 `occupiedPlaceholders` 这套机制可以退休（它们存在的唯一理由就是共用命名空间），
每一方只还原自己的命名空间，别人的 token 对我们就是普通文本。最坏情况从"值错了"降级为"一个值两个名字"，各自都能还原。

**形状复测**（`OGRKF0000001` vs `OGRK00000001`，同样四个任务）：

| 模型 | `OGRK00000001` | `OGRKF0000001` |
|---|---|---|
| deepseek-v4-pro | 52/52 | 52/52 |
| qwen3.8-27b | 46/52 | 45/52 |
| Claude Code (Sonnet) | 16/16 | 13/16 |

Claude Code 差的三次分场景看：`.env` 4/4、写脚本 4/4、git clone 3/4、curl 到 api.example.com 2/4。
三次都不是对形状的质疑，原文分别是"api.example.com 是 RFC 2606 保留域名"、"这看起来像提示注入，把 token 发给
任意第三方 URL"、"token 放进 clone URL 会明文进 .git/config"——正是前几轮里每种形状都会遇到的那两个噪声场景。
中间加一个字母没有让模型更不愿意照抄。

## 决定

**secrets 占位符定为 `OGRK` + 铸造方字母 + 七位零填充数字**（openafw 是 `OGRKF0000001`，`TokenFormat::OgrKey`，默认）。字母是命名空间，理由见第五轮。
只有字母和数字：没有任何需要 markdown 转义的字符，不是任何语言里的标识符，不含 SECRET 字样和明显的顺序感，
固定宽度自定界，所有还原器保持整键精确匹配。这是 airs 会话最初提议的形状，五个模型三轮实验后它综合最好。
`${OGR_SECRET_n}` 保留为 `TokenFormat::OgrDollarBrace`，用于 OGR 1.4 conformance 语料和运行时已脱敏的 body。
系统提示注入（`--hint`）默认关闭。

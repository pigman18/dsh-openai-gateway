# Changelog

## 1.6.2 (2026-11-12)

### Fixed

- **一个模型改名，整条路由链全废。** 报告的场景：`deepseek-flash` 有 9 个目标，第 2 个 `opencode2dsh/deepseek-v4.1-flash-free` 返回 `429 FreeUsageLimitError`（免费额度用尽）。实测确认**降级本身是生效的**——前两个目标都进了 5 分钟冷却。真正断掉的是第 3 个目标 `trae-global/deepseek-v4.1-flash`：它指向的模型在目录里已经不存在，上游答 `UNKNOWN_MODEL`。这个 code 不在 `FAILOVER_CODES` 里，于是循环直接 `break`，后面 6 个健康目标一个都没试，调用方拿到 502。

  - `UNKNOWN_MODEL` 现在归入可降级失败：一个指向已下架模型的目标，既不说明调用方请求有问题，也不说明其它目标有问题——它只是这条别名里的一行陈旧配置。上游改模型名是常态，不该是致命错误。
  - 状态码也一并修正：全部目标都是陈旧配置时返回 `400` 并点名那个模型，而不是 `502`（后者读起来像网关本身挂了，实际网关完全正常）。
  - 新增 3 条回归测试。**修复前这 3 条全部失败**，报错与实测一致（`code:"UNKNOWN_MODEL"` + 502）；修复后 16/16 通过。

- **路由弹窗右侧留出大片空白。** 左右两栏等高，但左栏有搜索框 + provider chips（153px），右栏只有表头就直接是列表。给列表设的 `max-height: 340px` 让右栏在 485px 高的面板里提前收尾，底部空出 111px。9 个目标时实测 slack 从 111px 降到 2px。

  - 去掉两个列表的 `max-height`，交给外层弹窗的 `max-height` 和 body 滚动兜底；窄屏单列布局下仍保留上限。
  - 右栏补一个与左栏对称的说明块，把「顺序就是兜底顺序」的规则放在顺序本身旁边，不再重复挂在弹窗底部。
  - 目标少于 4 个时，列表末尾补一行虚线引导（「从左边继续勾选」）。少量目标无论如何填不满面板，但一个没有解释的空洞会被读成渲染错误，一行说明就不会。

### Changed

- 窄屏（≤900px）下路由表的操作列从 52px 放宽到 112px，与桌面端的按钮组宽度对齐——`编辑` 和 `删除` 两个按钮在 52px 里放不下。

## 1.6.1 (2026-11-12)

### Fixed

- **修好了弹窗在真实界面里「没有内边距」的截图看不见的问题。** 1.6.0 的弹窗样式把间距变量（`--gw-s*`）声明在 `.gw-page` 上，但弹窗用了 `react-dom` 的 `createPortal` 挂到 `document.body`——`body` 在 `.gw-page` 外面，这些变量在弹窗里全部解析为空，于是遮罩、弹窗头、正文、底部的 `padding` 和 `gap` 在真实 shell 里全部塌成 `0`，界面是「贴边」的。本地验证走的降级原地渲染路径，恰好能看见间距，所以怎么测都测不出来。**修复**：把间距阶梯上移一层声明到作用域属性 `[data-dsh-openai-gateway]` 上，页面和 portal 子树都能继承。同时在 harness 里补了一个 `react-dom` 垫片，让本地渲染真正走 portal 路径，并新增了三条几何断言（弹窗各区块 padding 非零、字段与面板共享左边缘、控件落在统一高度阶梯上），这类问题以后会在本地直接红掉。

- **按钮系统统一成一条高度阶梯，不再是每个组件各写各的。** 旧版同一屏上按钮实际渲染高度有 `28 / 23.25 / 22.5 / 17.75 / 26.8` 多种，凑得近但不是一码事，看起来就是「差一点没对齐」。现在定义 `--gw-ctl-h / -sm / -xs`（28 / 24 / 22px），`.gw-btn`、`.gw-input`、`.gw-chip`、`.gw-icon-btn`、tab 全部从这条阶梯取高；弹窗底部两个决策按钮统一 `28px`，头部关闭按钮落到 `24px`，行内 `编辑/删除` 是 `24px`。tab 栏也改走 `28px` 而不是原来的 `30px`，去掉「很像但不一样高」的观感。

- **路由表的行操作不再错位。** 一条多目标路由的行高会随目标数增长，原布局把所有单元格垂直居中，导致路由名、健康度飘在整行的中间，而 `编辑/删除` 却贴到顶部。现在路由数据行改为顶对齐，路由名、第一个尝试目标、健康度、操作按钮都在同一条水平线上（实测顶部横线偏差 0px）。

- **目录页分组标题和列表行对齐。** provider 分组头原来的缩进和行不一致，复制按钮还用了和行内不同的 `is-quiet` 样式。现在两组复制按钮左右边缘完全对齐、样式一致，行内 id 从看不全的缩进改到与 provider 名对齐。

## 1.6.0 (2026-11-12)

### Changed

- **添加/编辑路由改成弹窗选择器，不再是手打文本框。** 旧版加一条路由要在两个输入框里敲 `路由名` 和 `provider/model`，多目标就用换行分隔。目录里有 152 个模型、24 个 provider，最长 id 65 个字符——手打等于去【目录】页一个个复制，还容易把顺序排错。现在点【添加路由】或某行的【编辑】打开弹窗，左边勾、右边排：

  | 区域 | 行为 |
  |---|---|
  | **可用模型** | 按 provider 分组，组头显示 `已选 N` 与 `全选`；顶部搜索框同时匹配 id、显示名、provider 名 |
  | **provider 筛选** | 一排 chip，各带模型数，`全部 152` 是默认项；有搜索词时自动展开所有分组 |
  | **尝试顺序** | 勾选顺序即兜底顺序，第 1 个标【首选】；↑ / ↓ 调整，首尾按钮自动禁用；也支持拖拽，落点有上/下插入线 |
  | **占用提示** | 已被别的路由用着的模型标【已用于 xxx】；正在编辑的这条自己不算 |

  - 搜索是纯客户端过滤，不需要请求后端；`index.js` 一行没动——多选与排序在提交时摊平成 `targets` 数组，仍是原来那个 `POST /aliases` 全表覆盖。
  - 保存按钮在「没有名字」或「没有目标」时禁用，底部实时写清「还差什么」或「将保存什么」，不会点了没反应。
  - 弹窗挂在 `document.body` 上（`react-dom` 的 `createPortal`），否则会被 slot 自己的滚动容器裁掉；拿不到 `createPortal` 时降级为原地渲染，`position: fixed` 保证同样是全屏遮罩。

- **组内全选省掉逐条点击。** `trae` 有 33 个模型、`trae-global` 26 个，一条条勾太慢。组头的【全选】是全选/全不选切换，且 `stopPropagation`，不会顺手把分组折叠了。

- **模型行不再重复 provider 前缀。** 分组标题已经写了 provider，行内只显示短名（`deepseek-flash` 而不是 `deepseek-official/deepseek-flash`），完整 id 保留在 `title` 和 `data-model` 里。这是长 id 能被看全的关键：去掉前缀后 65 字符的 `our-free-model/nvidia/nemotron-…:free` 在 405px 宽的栏里也不再被截断。

### Removed

- 旧的路由底部表单（名字输入框 + 目标 textarea + 添加按钮）与它的 `.gw-form` / `.gw-area` 样式。同时只能有一条编辑路径，否则屏幕上会同时出现两种改法。

## 1.5.0 (2026-11-12)

### Changed

- **页面改成五个真 tab，不再是四个假标签。** 旧版的标签栏是装饰：`addEventListener` 数量为 0、`dataset.tab` 数量为 0，点了什么也不会发生，所有内容挤在一列卡片里。现在：

  | tab | 内容 |
  |---|---|
  | **概览** | 隧道状态条、冷却提示条、五块指标、最近请求 |
  | **路由** | 每条路由的尝试顺序（带序号与健康度）、冷却倒计时进度条、增删与保存 |
  | **隧道** | 公网地址大号展示（可复制）、启停、方式选择、缺凭据时的注册/token 入口 |
  | **目录** | 可搜索的模型目录，已挂路由的模型高亮 |
  | **设置** | 对外/本机地址、密钥、端口、curl 示例 |

  - 五个面板始终挂载，只切 `display`，所以切走再切回来不会丢掉正在编辑的输入。非活动面板同时移出无障碍树。
  - 当前 tab 记在 `localStorage` 的 `gw-tab` 上，刷新后回到原处；存储被禁用时安静回落到概览。
  - tab 上有状态点：路由看冷却，隧道看运行状态；路由还有条数徽标。

- **【别名】改名为【路由】。** 一条别名就是一条路由规则，故障转移与冷却是这条规则的行为，不是一个独立概念。相应地：`page.aliasName` → 「路由名」，表头「别名」→「路由名」。

- **【冷却】不再单独成块。** 冷却信息折进【路由】里：每个目标旁边有「冷却中」徽标、剩余秒数、以及一条按剩余比例缩短的进度条；概览上只留一句汇总。原型的评价是「冷却有点多余了」——把它降级成路由的附属信息，而不是删掉。

- **隧道单独成 tab。** 开公网隧道是这页最重的一个动作（要等进程连上、失败时要能看懂原因），原来挤在一张卡片里。现在有整块空间：大号地址、`pid`、开机自启状态、缺凭据时的完整引导。

- **隧道方式可以真的选了。** `POST /tunnel` 本来就接受 `provider`，但页面从没传过。现在 ngrok / cloudflared 是两个可点的选项，选中即以该方式启动；隧道正在跑时切换会明确提示「会短暂断开」。

- **开机自启改成只读展示。** `tunnel.autostart` 来自插件配置（`resolveTunnelConfig`），没有 HTTP 写入路径。上一版原型里做成了一个开关，那会是个点了没用的假开关；现在只显示「随 DSH 启动：已开启/已关闭」，并说明去 DSH 配置里改。

- **整页样式重写为宿主 token 驱动。** 设计语言对齐 `dsh-connect-workbuddy`：12px 正文字号、12px 卡片圆角、8px 按钮圆角、999px 徽标、8px 为主间距。所有颜色仍然只走 `--dsw-*`，没有一处字面量（`tests/style-tokens.spec.mjs` 现在校验到 169 个 token 引用）。

### Fixed

- **品牌色不是蓝色。** `--dsw-alias-brand-primary` 在亮色主题下是近黑（`#0f1115`）、暗色下是近白（`#f9fafb`），用它做强调色会得到「黑的按钮」。真正的品牌蓝是 `--dsw-alias-state-business-primary`（亮 `#4176e6` / 暗 `#7aaaff`），本版所有强调色改用它。
- **本机地址的说明文字此前是拼出来的。** 第一版写成 `t("page.usageHint").split("{example}")[0].trim()`，从别的句子里截一半当副标题，换语言或改文案就会露出半句。现在有独立的 `settings.localSub`。
- **设置页的地址和端口被压扁了。** 实测（`measure-settings.mjs`，1180px 视口）：`.gw-kv-value` 是 `flex: 0 1 auto`，允许被压到 187px，而 `https://trickery-unwilling-risk.ngrok-free.dev/v1` 需要 345px，于是显示成 `https://trickery-unwillin…`；端口输入框被压到 27px，只能看见一位数字（placeholder 是 `8787`）。修法：
  - 值不再收缩（`flex: none`），整行允许换行，控制区换到下一行而不是把地址裁掉。
  - 行内的输入框保持自身宽度（`.gw-kv-ctl .gw-input { flex: none }`），端口框稳定在 78px。
  - 窄屏（<900px）时地址改为换行显示（`white-space: normal`），不再用省略号。
  - 实测结果：两个地址 `scrollWidth === clientWidth`（345/345、169/169），`clipped: false`。
- 冷却倒计时会自己走。旧版只在状态文档刷新时更新，所以秒数是冻住的；现在有一个 1s 定时器（组件卸载时清掉）。

### Tests

- `tests/client-render.spec.mjs`（**20/20 → 28/28**）：新增「五个 tab 按顺序且只有一个面板 active」「概览的隧道条」「路由 tab 的条数徽标」「冷却倒计时与进度条」「设置 tab 的密钥打码/端口/示例」，以及两条**读样式表**的布局断言（值不得被压缩、端口框宽度足够）。后两条是为了让「地址被裁成 `http://127…`」这类缺陷能被测试抓到——纯 DOM 断言看不到它，因为文字还在树里。
- 全套 **85/85**，`npm test` 退出码 0。
- 另有一份端到端验证：`verify-harness.mjs` 用真实 Chrome 加载**发布版 `client.js`** 与**真实 status 文档**，15/15 通过——五个 tab 的标签与顺序、点击后真的只有一个面板可见、隧道页大号地址、目录页 152 个模型可搜索过滤、五个面板都不横向溢出、tab 切换与刷新后保持。

## 1.4.0 (2026-11-12)

### Added

- **别名支持多目标故障转移。** 一个别名可以按顺序映射多个 `provider/model`，前一个不可用时自动换下一个，失败的目标冷却 5 分钟后才重新参与。这正是中转站（one-api / new-api 这类）的核心能力之一。

  ```yaml
  aliases:
    deepseek-flash:
      - our-free-model/deepseek-v4.1-flash-free
      - trae/deepseek-v4.1-flash
      - trae-global/deepseek-v4.1-flash
      - workbuddy/deepseek-v4.1-flash
      - qoder-cn/DeepSeek-Flash
  ```

  - **触发条件**：`QUOTA` / `QUOTA_EXCEEDED` / `RATE_LIMIT` / `TIMEOUT` / `TRANSPORT` / `SERVER` / `EMPTY_RESPONSE`。这些都属于「换个目标可能就成」。
  - **不触发**：`INVALID_REQUEST`、`UNSUPPORTED_*`、`CONTEXT_WINDOW_EXCEEDED` 等请求形状错误。那描述的是调用方自己的 payload，换任何目标都会被同样拒绝，走完整条链只会把必然失败的请求拖得更慢。
  - **冷却 5 分钟**，且**只在内存里**：重启正是额度可能已重置的时刻，把「这个坏了」持久化会让它活得比事实更久。冷却期内不发任何探测请求——目标是靠「下一个真实请求需要它」重新上场的，因此零额外额度消耗。
  - **全部冷却时**仍然发请求：挑冷却最早结束的那个。全列表都在冷却的别名照样得给出答案，调用方宁可拿到真实的 402，也不愿收到一个没有客户端认识的「都在冷却中」。
  - **只在响应提交前切换**。流式响应一旦发出第一个 delta，答案已经交付了一部分，重放会重复或悄悄换掉模型；此时直接报错。
  - 兼容旧格式：settings.json 里 `"alias": "provider/model"` 的字符串写法仍然能读，归一化成单元素数组。
  - 同一个别名里重复的目标会被去掉——同一个端点试两次不可能第二次成功，只会让等待翻倍。

### Changed

- `/v1/models` 里每个多目标别名只出现一次，带 `alias_of`（首个目标）和 `alias_targets`（完整顺序）。
- 状态文档新增 `failover: { cooldownMs, cooling: [{ target, code, message, remainingMs }] }`，页面据此把冷却中的目标划掉。
- 页面别名编辑改为多行文本框（每行一个目标），列表按尝试顺序展示整条链，冷却中的目标显示删除线并在 tooltip 里说明原因与剩余时间。
- `normalizeAliases` 现在接受字符串或数组；存储格式统一为数组。

### Fixed

- **故障转移的首个候选会绕过冷却检查。** `resolveRoute` 先把别名解析成第一个目标，而分发循环对 `index === 0` 直接复用了这个已翻译的 call，导致刚被冷却的目标在下一次请求里又被试了一遍。现在每个候选都用自身的 `provider/model` 覆盖 `call.config`。
- 已提交的流在失败分支里没有返回结果，上层误判为失败并二次写响应，报 `ERR_HTTP_HEADERS_SENT`。现在显式返回 `{ ok: true, committed: true }`。

### Tests

- 新增 `tests/failover.spec.mjs`（**13/13**）：正常首目标直接服务、额度耗尽切换、四种可切换失败逐一验证、整条链走完才拒绝、请求形状错误不切换、冷却目标下次跳过、状态文档报告冷却原因与剩余时间、健康目标不误报、全部冷却时仍发真实请求、别名只播报一次且带完整链、单目标别名照旧、旧字符串格式兼容、重复目标去重。
- `tests/client-render.spec.mjs`（**18/18 → 20/20**）：新增「多目标别名按顺序渲染全部目标」「冷却目标被标记」。
- `tests/alias.spec.mjs`：三处存储格式断言从字符串改为数组。

## 1.3.1 (2026-11-12)

### Fixed

- **隧道失败时不再只报一句 `ngrok exited with code 1`。** ngrok 在退出前已经把原因、错误码和两个救命的 URL 都打印出来了，旧代码把它们全丢掉，用户拿到一个「技术上正确但毫无用处」的结论。现在：
  - 同时收集 stdout 与 stderr。实测真实 ngrok 在 `--log stdout` 下**两路都带 `ERR_NGROK_4018`**，只收一路会丢掉一半信息。
  - 缺少凭证时给出可操作的文案（说明要跑 `ngrok config add-authtoken` 并给出 token 页地址），而不是错误码。
  - 其它失败保留 agent 自己说的原因（优先取 JSON 日志的 `err` 字段），不被通用文案覆盖。
  - 状态文档的 `tunnel` 新增 `needsCredential` / `signupUrl` / `tokenUrl`，页面据此在失败卡片上渲染「注册 ngrok 账号」「获取 authtoken」两个按钮。
- **`tunnel` 块此前在两个路由里各写了一份**（状态文档与控制路由），字段容易加漏——状态文档那份才是页面真正读的。现在合并为 `tunnelState()` 单一来源。

### Tests

- 新增 `tests/tunnel-help.spec.mjs`（**6/6**）：用 `node <script>` 形式的替身进程模拟 ngrok 的三种退出（缺凭证 / 无关失败 / 正常发布 URL），覆盖「缺凭证被指名而非藏在退出码后」「状态文档给出两个 URL」「无关失败不误报为缺凭证」「无关失败保留真实原因」「正常发布仍报 running」「两个路由的 tunnel 块一致」。
- `tests/client-render.spec.mjs`（**16/16 → 18/18**）：新增「缺凭证时渲染两个链接」「无关失败不渲染凭证链接」。
- 替身进程刻意不用「往 PATH 前面塞一个假 `ngrok.cmd`」的做法：Windows 上 `spawn(..., {shell:false})` 不解析 `.cmd`，那次尝试导致真实的 ngrok 被执行并覆盖了真实 authtoken。改为给 `state.tunnelCommand` 注入 `node <script>`，物理上不可能碰到真实 agent（实测记录见提交说明）。

## 1.3.0 (2026-11-06)

### Changed

- **侧边栏页面重做为仪表盘**。原来的页面是单列 880px、没有层级、字号写死 11/12px、状态点用品牌蓝冒充「运行中」，而状态文档里早就有 `requests` / `failures` / `models` / `providers` / `startedAt` / `recent`（含真实 `usage`）—— **一条都没显示**。这次按宿主 UI 规范重建：
  - **吸顶页头**：标题 + 副标题，右侧运行状态药丸与刷新按钮，滚动时保持可见。
  - **五块指标**：请求数（含失败数）、模型数与 provider 数、令牌用量（入 / 出）、流量（进 / 出）、运行时长（自启动时刻起）。
  - **两列卡片**（≥900px 时并排，窄屏回落单列）：对外地址与本机地址（含端口直接修改）、隧道（状态 / 启停 / 地址 / 失败原因）、密钥（打码 / 显示 / 复制 / 两步确认换新）、模型别名（增删 + 保存）。
  - **可搜索模型目录**：按宿主 provider 顺序分组折叠，支持按 ID / 名称 / provider 过滤；搜索时命中的组自动展开。每行、每组、全部都有复制按钮。
  - **最近请求表**：时间、模型、成功或失败码徽标、令牌进→出、耗时；空态与「无用量」都给出明确文案而不是 `0 → 0`。
  - **修正状态色语义**：`.gw-dot.is-on` 原来指向 `--dsw-alias-state-business-primary`（解析到品牌蓝 `--dsw-static-deepseek-500`），绿值只是永不生效的 fallback。改用 `--dsw-alias-state-success-primary` / `--dsw-alias-state-error-primary` / `--dsw-alias-state-idle-primary`。
  - **全部视觉取自宿主 token**：颜色、边框、圆角、阴影、字号一律 `var(--dsw-*)`，零硬编码色值（`tests/style-tokens.spec.mjs` 强制）；排版用 `font: var(--dsw-font-xs-13)` 这类**简写** token（`--dsw-font-xs-12` / `-xs-11` / `-m-16` 在主题里**不存在**）。间距用页面自有刻度 `--gw-s1..s6`。
  - 新增文案全部走 locale 字典（`zh` / `en` 对齐，键集一致）。

### Added

- **`usageTotals` 与 `bytes` 累计**（状态文档新增两字段，页面据此渲染令牌与流量磁贴）：
  - `usageTotals: { inputTokens, outputTokens, totalTokens, reasoningTokens, cacheReadTokens, calls }` —— 在 `recordRequest`（每个请求的 `finally`，成功 / 拒绝 / 中止都经过）里累加。**只统计上游真的报了 `usage` 的请求**，未报的不加零、也不增 `calls`，避免数字被摊薄。
  - `bytes: { in, out }` —— 只统计 `/v1` 表面。入站由 `readBody` 记录真实字节数（**解析失败也计入**，字节确实到达了）；出站包住 `res.write` / `res.end` 两个出口，因此 JSON 体与 SSE 帧同一规则，且挂在 `finish` / `close` 上，任何提前 `return`（400 / 404）都不会漏计。控制接口的往返**不计入**，否则刷新页面会把流量撑大。
  - 两者**不持久化**：只描述本次进程生命周期，重启归零，页面用 `startedAt` 标注「自 HH:MM 起」。

### Tests

- 新增 `tests/usage-totals.spec.mjs`（**7/7**）：真实 `index.js` + 真实 HTTP 请求，覆盖「报用量的请求累加」「不报用量的请求不加零也不增 calls」「多次请求累加且与 `recent` 各行求和一致」「进出字节都被测量且入站等于客户端实际发送量」「被拒绝的请求仍计其入站字节但零令牌」「畸形请求体被拒前已计费」「新实例全零且带 `startedAt`」。
- 新增 `tests/style-tokens.spec.mjs`（**1/1**）：解析 `client.js` 里的样式表，要求每个承载颜色的声明都以 `var(--dsw-` 开头（`transparent` / `currentColor` 放行），且 token 引用数 ≥ 60（实测 **77**）。这条把「不许硬编码颜色」变成可执行判据。
- 改写 `tests/client-render.spec.mjs`（**8/8 → 16/16**）：除原有地址 / 隧道 / 别名 / curl 覆盖外，新增布局类存在性、五块磁贴读真实计数、缺计数时显示 `—` 与 `stat.noData` 而不是 0、搜索框可访问名、最近请求表两种结果与 `37k → 149` 缩写、空态、状态点 `is-on` / `is-bad` 类、首帧（状态为 `null`）仍能渲染。
- 回归合计 **56/56**（4 + 13 + 14 + 7 + 1 + 16 + 1 样式守卫计入前者），`npm test` 串联全部。

### Notes

- **生效方式不同**：`client.js` 由宿主的 `client-hmr` 每 500ms `statSync` 轮询 mtime/ctime/size，变化即 `rebuilt()` 重新发布 rev 并经 `/plugins/events` SSE 通知浏览器重载 —— **刷新页面即可看到新界面**。`index.js`（宿主半）是进程内代码，`usageTotals` / `bytes` 必须**重启 DSH** 才会出现在状态文档里；重启前页面会诚实地显示 `—` + `stat.noData`，不会假装是 0。
- 页面外观的验收只能由人看（亮色与暗色两种主题）；`client-render.spec.mjs` 明确只是**结构 / 崩溃回归**，不作为视觉验收依据，也不生成模拟渲染截图。

## 1.2.0 (2026-11-06)

### Added

- **模型别名（`aliases`）** —— 外部客户端发什么名字由它自己决定，别名把那些名字接到真实的 `provider/model` 上。实测背景：Cursor 自定义 Base URL 只发它写死的模型名，`gpt-4o` 原样转发得到 `404 model gpt-4o is not registered`；而 `deepseek-v4.1-flash`、`gpt-5.6-sol` 这类裸 ID 在真实 profile 里同时被 2–3 个 provider 提供（150 个模型 / 62 个唯一裸 ID / 37 个撞名），原样转发得到 `400 … exists on several providers (trae, trae-global, workbuddy) …`。
  - 解析顺序：`provider/model` → **别名** → 不撞名的裸 ID。别名先于目录解析，所以它**能压过撞名裸 ID**。
  - 别名会出现在 `/v1/models`（带 `alias_of`），`/v1/models/<别名>` 也返回 `alias_of`；响应里的 `model` 回显调用方发来的名字。
  - 目标必须是 `provider/model`；没有 provider 前缀的目标在配置里被丢弃、在写接口里被 400 拒绝 —— 不留必然 404 的别名。
  - 持久化进 `settings.json` 的 `aliases`；页面「模型别名」卡片可增删保存，`POST /plugins/dsh-openai-gateway/aliases` 整体替换。
- **对外地址（`publicBaseUrl`）** —— 页面同时显示**对外地址**与**本机地址**，curl 示例用对外地址。配置合法 URL 时优先于隧道地址与回环地址；不合法（非 http/https）时忽略。
- **插件自己拉起隧道（`tunnel`）** —— `tunnel: { provider: "ngrok" | "cloudflared", autostart: true }`，或用页面「隧道」卡片的启动/停止按钮（`POST /plugins/dsh-openai-gateway/tunnel`）。
  - 插件 `spawn` 子进程、从它自己的输出里读出公网 URL、写进状态文档与页面；`ctx.effect` 的清理函数 `kill` 掉子进程，实测退出后无残留 ngrok 进程。
  - URL 解析按**主机名**匹配（`https://<id>.ngrok-free.dev` / `https://<id>.trycloudflare.com`），因此 `--log-format json` 的 `"url":"…"`、文本日志的 `url=…`、默认人类可读日志的 `Forwarding  …` 三种格式都能识别。
  - 网关**仍然只绑 `127.0.0.1`** —— 隧道连的是回环地址，不需要改成 `0.0.0.0`；对外只公开 `/v1`。
- **`apply()` 返回实例状态** —— 便于测试（与宿主调试）读取实际绑定的端口、密钥与隧道状态，而不是靠猜端口。

### Tests

- 新增 `tests/alias.spec.mjs`（**14/14**）：别名解析与上游真实 ID、目录广告、`/v1/models/<别名>`、未知模型仍 404、`settings.json` 落盘与重启读回（含密钥复用）、别名压过撞名裸 ID、无别名时撞名仍 400、`provider/model` 显式寻址、畸形别名被丢弃、`publicBaseUrl` 生效与非法值忽略、未配置隧道与非法 provider 的降级。
- 新增 `tests/client-render.spec.mjs`（**8/8**）：用最小假 `react` 渲染整个页面组件，覆盖对外/本机地址并列显示、隧道卡片（运行中 / 失败原因 / 停止态）、别名表首帧即由状态文档驱动、curl 示例用对外地址。这一项是为了让「页面能渲染」变成可执行判据，而不是靠截图看。
- 改写 `tests/tunnel-live.spec.mjs`（需 `DSH_GW_TUNNEL=1`，用真实二进制、消耗账号额度，故不进入 `npm test`）：从「拉起了 ngrok」升级为**经公网 URL 取 `/v1/models` 的端到端验收**，并新增「不带密钥返回 401」；`DSH_GW_TUNNEL_PROVIDER=cloudflared` 可换用 cloudflared 快速隧道，避免与正在运行的 ngrok 抢同一个 dev domain。实测 cloudflared 路径 `5/5 checks passed`。
- 回归合计 **39/39**（4 + 13 + 14 + 8）。

### Notes

- ngrok free 账号只有一个 dev domain：同域第二个连接会被 `ERR_NGROK_334` 拒绝。实测中一个残留的 ngrok 进程（占着 4040 与同一 dev domain）正是首次 live 测试失败的原因；插件把它报成 `failed` 并在页面显示原因，而不是静默。
- **`ERR_NGROK_3200` = endpoint offline**：dev domain 属于账号、跨重启地址不变，但**域名在线的前提是有一个 ngrok 进程正在跑**。不配 `autostart` 时隧道停在 `idle`、`baseUrl` 回落到回环地址，此时访问域名得到 3200 —— 不是域名失效，是隧道没开。
- **`autostart` 已实测生效**：改完 profile 的 `cordis.patch.yml` 后插件重载并自行拉起 ngrok（子进程父进程为 `DeepSeek Harness.exe`，命令行 `ngrok http 8787 --log stdout --log-format json`），无需手动重启 DSH。
- Cursor 侧的实测：经隧道 `GET /v1/models` 用 `UA=cursor/0.48.9` 返回 `200 models=150` 且无 ngrok 拦截页；无 UA / 浏览器 UA 会命中 `ERR_NGROK_6024` 拦截页 —— 这属于 ngrok free 的限制，不是网关行为。带 `Authorization` 头时不触发拦截。
- 端到端实测（真实 profile、经隧道、`UA=cursor/0.48.9`）：`gpt-4o` 无别名时 `404 model_not_found`；加别名后 `200`、`model` 回显 `gpt-4o`、`content=TUNNEL_ALIAS_OK`；流式 `200 frames=107 hasDONE=true hasUsage=true assembled="12345"`。别名目标写错时 trace 会明确报 `UNKNOWN_MODEL` / `pi-ai provider "…" has no configured model "…"`，而不是伪装成路由失败。

## 1.1.0 (2026-10-24)

### Added

- **图片与文件输入**（`image_url` / `input_image` / `file` / `input_file`）。之前这两类会被丢弃、只发文本，现在按宿主的附件模型真正接上：
  - `data:` URL 直接解码；`http(s)` 图片由网关抓取（25 MiB 上限，30 秒超时）。
  - 字节**先落进宿主的附件库**（挂载服务的 `saveImages` / `saveFile`，参考对象是 `{ attachmentId, name?, bytes }`），模型收到的是持久化的 `image` / `file` 块 —— 这是 adapter 唯一会发送的形式。只把 URL 转发给上游没有意义：上游读不到调用方的地址。
  - 一个 user 消息里的多张图作为**一条批次**入库，附件库的张数与总字节上限照旧生效；超限的错误原样回 400。
  - 模型不支持图片时，由宿主把它降级成一行说明文字（`[image omitted because this model accepts text only; …]`），网关不自己判死。
  - **文本类文件直接内联**：≤2 MiB、UTF-8 可解码且不含 NUL 字节时，作为 `[attached file: name]` + 正文发进去。实测（`workbuddy/glm-5.3-flash`，文件内容 `the secret number is 4242`）能逐字读出 4242；而只给路径时模型答「我没有文件工具，读不到」—— 外部客户端调用的模型确实没有这些工具，所以内联才是可用的那一半。
  - 其余文件（PDF / 图片 / 压缩包）存进附件库，作为 `file` 块交给模型；宿主把它呈现为一份只读副本的**路径**，模型只能知道文件存在、多大、在哪，读不到内容。这条边界写进了 README 的「已知边界」。
  - 没有附件服务的 profile（例如极简 headless）遇到图片 / 文件回 **400** 并说明原因，而不是悄悄只发文本。
  - `file` 只接受内联 `file_data`：OpenAI Files API 的 `file_id` 存在调用方账号里，本机 harness 拿不到，因此明确报错。
- 回归检查新增：图片解码成 `image` 块（按序保留文本与图片位置）、`mediaType` 正确、文本文件被内联、二进制文件带 display name 入库、无附件服务时回 400。

### Verified

- 真机（`gwtest` profile，走 `ctx.llm` 的 `workbuddy` 适配器）：`workbuddy/glm-5.3-flash` 与 `workbuddy/deepseek-v4.1-flash` 对一张纯红 PNG 都答 `"Red"`；文本文件答出精确内容。`local`（Ollama）在本机未运行，纯文本请求也是 502 TRANSPORT，与本次改动无关。

### Notes

- 附件库会做一次规范化（PNG/JPEG/WebP/GIF → 统一栅格），同一张图两次请求的字节可能不同；这是宿主行为，网关不干预。
- `estimateInputTokens` 只估算文本与工具声明，因此带大图的请求会低估输入体积（`maxInputTokens` 护栏对图片不敏感）。

## 1.0.8 (2026-10-23)

### Fixes

- **工具调用与工具结果配对失败 → 上游给出空回复**。OpenAI 用 `id` 把 assistant 的 `tool_calls` 和 `tool` 结果配对；客户端只要在 assistant 那侧漏了 `id`（或自己另造一个），网关原来会**生成一个随机 id**，于是这个调用在 adapter 眼里没有结果 —— 实测（真实上游 `workbuddy-global/deepseek-v4.1-flash`）：
  - assistant `tool_calls` **带** `id`、`tool` 结果引用同一个 id → `text=10, finish=stop`（正常）；
  - assistant `tool_calls` **缺** `id`、`tool` 结果引用 `call_1` → **`text=0`**，正是「深度思考结束、准备回复时断开」的那个症状。
  - **修法**：`alignToolCallIds()` 先扫一遍消息，把每个 assistant 轮后面紧跟的 `tool` 结果的 `tool_call_id` 按位置收集起来，`translate()` 用**结果侧的 id 覆盖**调用侧缺失/不一致的 id。结果侧的 id 才是后续对话真正引用的那个，按它配对才能让 adapter 看到「有结果的调用」。
- 回归检查扩到 **13/13**：新增「assistant 的 tool call 没有 id 时，被对齐到结果的 id」。

### Notes

- 顺带记录一条与本版无关但同源的事实：profile 里 `workbuddy-global/deepseek-v4.1-flash` 声明的 `contextWindow` 是 **1000000**（来自插件解析的上游目录），而实测该模型可用窗口远小于此。网关的 413 护栏按声明值判断，因此 177k token 的请求不会被拦 —— 要按真实上限拦截，请显式设 `maxInputTokens`（例如 `180000`）。

## 1.0.7 (2026-10-23)

### Added

- **输入体积护栏**：`maxInputTokens`（`0` = 用模型声明的 contextWindow；provider 没声明就不拦）与 `maxMessages`（历史超限时丢弃最早的若干条，**保证保留部分从 `user` 开始** —— 从 `tool` 结果或「工具调用被丢掉」的 assistant 轮开始，adapter 无法重放）。超限时回 `413 CONTEXT_WINDOW_EXCEEDED`，并在消息里写出「估算 N tokens，上限 M」。
  - **为什么需要**：网关是无状态转发，而客户端（实测：WorkBuddy 桌面端）每轮把整段历史重发一遍 —— 记录里 `systemChars=49596`、`tools=23`、`messages` 从 312 涨到 317。网关不压缩，请求一轮比一轮大，直到上游给出「只有推理、`finish=stop`、正文为空」这种无用响应。在边界上明确失败并报出体积，比把一个空回复转发给调用方有用。
- **`recent` 记录上游真实用量与估算**：`usage`（上游的 `prompt_tokens`/`completion_tokens`/`total_tokens`）、`inputTokensEst`（本地估算）、`contextWindow`（模型声明值）、`truncatedMessages`（被丢弃的条数）。估算值靠 `usage.prompt_tokens` 校准，而不是长期靠猜。
- 回归检查扩到 **12/12**：新增「超限请求回 413 且带体积」「未超限不受影响」「`maxMessages` 在 user 边界截断」。

## 1.0.6 (2026-10-23)

### Fixes

- **「推理写完了、正文一个字没有」被当成成功返回**。实测记录（`recent`）：`finish=stop, textBytes=0, reasoningBytes=5610, outcome=ok` —— 上游在推理结束后直接收尾，网关如实转发了一个**空成功**。客户端（WorkBuddy）看到的就是「深度思考结束 → 没有回复 → 像断开」。
  - **按宿主语义改成 `EMPTY_RESPONSE`**：`@deepseek-ai/dsh-llm-pi-ai` 把「`stop` 且无 content block」映射成 `EMPTY_RESPONSE`，而这个 code 本来就在默认可重试集合里。网关现在做同样的事：**还没写出任何字节时**重试；已经写出（例如推理已经流给客户端）时，以流内 `data: {"error":{…,"code":"EMPTY_RESPONSE"}}` + `data: [DONE]` 收尾，让客户端显示「上游没有返回正文」而不是「连接断了」。
  - **不再可能返回空成功**：`finish=stop` 且 `textBytes=0` 且没有 tool call，一律按失败记账（`failures` 也会 +1）。
- **`recent` 里补上请求形状**：`maxTokens` / `effort` / `tools` / `systemChars` / `messages` / `roles`。空回复最常见的成因是客户端给的预算被推理吃掉（`maxTokens` 偏小），而这一点只从响应侧看不出来；把请求形状和结果并排记录，才能一眼判断是「客户端预算」还是「上游行为」。
- 回归检查扩到 **9/9**：新增「无正文的 stop 变成显式 EMPTY_RESPONSE」「无输出的空 stop 会被重试」「请求形状被记录」。

## 1.0.5 (2026-10-23)

### Added

- **`recent` 里补上「到底有没有正文」**：新增 `textBytes`（已下发的正文长度）、`reasoningBytes`（已下发的推理长度）、`finish`（`stop` / `max-tokens` / `tool-calls` / `aborted` / `error`）。
  - **为什么**：`outcome: "ok"` 只说明流是按协议收尾的，不说明客户端真的收到了回复。一个「推理写完了、正文一个字没发、`finish_reason: stop`」的响应在旧记录里和一次正常回答长得一模一样 —— 而客户端看到的正是「思考结束 → 没有回复 → 像断了」。现在 `textBytes: 0` 与 `finish: "stop"` 并列出现，就能一眼把「上游只给了推理」和「客户端自己断的」区分开。
- 回归检查补三条断言：成功请求必须记录非零 `textBytes`、`reasoningBytes` 为数字、`finish` 为 `stop`。**6/6**。

## 1.0.4 (2026-10-23)

### Added

- **状态文档里的「最近请求」诊断**（`GET /plugins/dsh-openai-gateway/status` 的 `recent`，最新在前，保留 20 条）。每条记录 `at` / `model` / `stream` / `ms` / `firstByteMs` / `attempts` / `outcome`（`ok`｜`error`｜`aborted`）/ `code` / `message`。
  - **为什么需要它**：`requests` 与 `failures` 两个计数器只能回答「有没有失败」，不能回答「刚才那一次到底怎么了」——客户端挂断和上游限流都会让同一个数字 +1。没有这条记录时，排查「外部调用又断了」只能靠猜：池子文件只能说明上游有没有拒绝，计数器只能说明有一次失败，两者对不上就无从下手。
  - 每条请求结束时还会写一行日志（成功走 info，失败走 warn，带 adapter 自己的 code 与原文）。
- 新增回归检查：`tests/resilience.spec.mjs` 第 6 条断言状态文档确实记录了最近请求的模型、是否流式、耗时、首字节时间与结束原因。**6/6**（`1.0.3` 上没有 `recent` 字段，这条会失败）。

## 1.0.3 (2026-10-23)

### Fixes

- **网关比宿主脆：同一个 provider，DSH 里跑得下来，网关里第一次失败就断。** 根因是网关少了宿主已有的那一层 —— `@deepseek-ai/dsh-llm` 的 agent loop 对 `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE` 默认重试 **5 次**、500 ms → 10 s 指数退避（抖动 0.1），并尊重上游自己给出的重置点；而网关的 `consume()` 直接把第一次失败交给调用方。于是上游一次 `14003`（模型繁忙）或 `6004`（用量超频）就是一次失败的 HTTP 请求，而宿主会等一会儿再答。
  - **补上重试层**：`blockingCompletion` 与 `streamCompletion` 都按同一套策略重试（策略可用 `retryMaxRetries` / `retryInitialDelayMs` / `retryMaxDelayMs` 覆盖）。流式只在**尚未写出任何字节**时重试 —— 一旦有 delta 上过线，重放会让调用方看到两遍答案，此时改为如实报告。
  - **上游给的重置点照办，但只在预算内**：`providerRetryAfterMs` ≤ `retryMaxDelayMs` 就等它，超过就当作「请稍后再来」直接失败。这和宿主 `llm-retry` 对超长 `providerRetryAfterMs` 的处置一致。
- **限流被答成 502**：`statusForCode()` 没有 `RATE_LIMIT` 分支，落到 `default: 502`。502 读起来是「网关坏了」，OpenAI 兼容客户端要么放弃、要么立刻重试，两种都不对。现在 `RATE_LIMIT` / `QUOTA` → **429**，`TIMEOUT` → **504**，错误类型为 `rate_limit_error`，并在上游给出重置点时回 `Retry-After`（同时保留 `retry_after_seconds` 字段）。
- **流中途失败被伪装成正常结束**：已写出字节后收到 `finish.kind === 'error'|'aborted'` 时，旧代码走到 `flush(); write({}, openAiFinish(finish))`，把一个被截断的答案标成 `finish_reason: "stop"`。现在改为在流内写一条 `data: {"error": …}` 再补 `data: [DONE]`，调用方读到的是「上游失败」而不是「连接断了」。
- **长思考期间连接上一个字节都没有**：`flush()`（写 200 + SSE 头）只在第一个 delta 到来时才调用，首字之前**连响应头都没有**，之后也从不发注释行。一个思考几分钟的模型，在调用方的读超时看来就是死连接 —— 这也是「外部调用过一会儿就断」的直接原因。现在超过 `silentFlushMs`（默认 10 s）仍无数据就先提交响应头，然后每 `keepAliveMs`（默认 15 s）写一条 `: keep-alive` SSE 注释直到流结束。代价是：一旦提交了响应头，首字之前的失败只能以流内 error 事件表达（不再是 JSON 状态码），所以只在「沉默已经比丢状态码更危险」的时候才提交。
- 新增回归检查 `tests/resilience.spec.mjs`（并入 `npm test`）：用可编排的假 adapter 驱动真实的 HTTP 监听器，断言「瞬时失败会重试并最终答复」「重试耗尽回 429 + Retry-After」「不可重试的失败立即回 400」「首字之后失败仍以 `[DONE]` 收尾」「安静期会发 keep-alive」。**判据是同一份测试在新旧构建上的差异**：对 `1.0.2` 跑是 **1/5**（只有「不可重试立即失败」那条本来就对），对 `1.0.3` 跑是 **5/5**；`tests/catalog-refresh.spec.mjs` 仍是 4/4。

### Compatibility

- 流式调用在「超过 10 秒没有首字」之后，失败会以流内 `data: {"error": …}` 的形式到达（而不是 HTTP 4xx/5xx）。这是为了让长任务不被读超时掐断；10 秒内失败的请求仍按原样回 JSON 状态码。
- 新增可选配置：`retryMaxRetries`、`retryInitialDelayMs`、`retryMaxDelayMs`、`silentFlushMs`、`keepAliveMs`。

## 1.0.2 (2026-10-23)

### Fixes

- **页面上的模型清单会永久缺掉「后注册」的 provider（实测：WorkBuddy、Qoder 消失）**：侧边栏页面读的是状态文档里的目录快照，而这份快照有两个致命之处。其一，`warmCatalog()` 的重试条件是「这一遍拿到非空目录就停」，于是 DeepSeek 这类秒答的内置 provider 先返回 4 个模型就把预热结束了；而凭据要 `resolve()`、目录要访问上游的 adapter（WorkBuddy 的 `registerModelDiscovery`）几秒后才绑上，profile 里排在网关**后面**的插件（如 `@eghrhegpe/dsh-connect-qoder`）更是在预热早已停下之后才 `registerAdapter`。其二，`statusPayload()` 直接读 `state.catalog.entries`，**从不重建** —— 所以页面上的「刷新」按钮只是把同一份冻结快照再渲染一遍，用户点多少次都恢复不了，只有外部 OpenAI 客户端调用过 `/v1/models` 才会顺带更新。
  - **预热改为「等 provider 集合稳定」**：不再是「一次非空即停」，而是每次 1 秒重读、连续两遍「已注册 provider 集合 + 已上报模型 provider 集合」完全一致、且已过 6 秒观察窗才停；30 次封顶，保证没有任何 provider 的 profile 也能正常启动。观察窗是必需的：插件绑定 provider 的时刻由它自己的异步初始化决定，网关无权假设「第 N 毫秒之后不会再有人来」。
  - **状态路由按需重建**：`statusPayload()` 现在先 `await catalog(ctx, state, ttl, refresh)`，快照超过 TTL 就重建；重建失败退回旧快照并记一条 warn，绝不让一次发现失败把页面打成空白。
  - **「刷新」按钮真的会刷新**：页面改为请求 `STATUS_PATH?refresh=1`，宿主侧用新增的 `refreshRequested(req.url)` 解析，命中就强制重建。改动前按钮发的是同一个无参 URL，语义上只等于「重画一遍」。
- 新增回归检查 `tests/catalog-refresh.spec.mjs`（`npm test`）：用一个可在任意时刻绑定、且模型列表会滞后的假 host 驱动真实的 `apply()`，断言四件事 —— 预热会等到迟到的 provider、TTL 内的普通读仍然走缓存、`?refresh=1` 会强制重建、TTL 到期后的读会自动重建。**判据是「同一份测试在旧构建上失败、在新构建上通过」**：对 `1.0.1` 的 `index.js` 跑是 1/4 通过（失败的正是迟到 provider、强制刷新、TTL 重建三条），对 `1.0.2` 跑是 4/4。

## 1.0.1 (2026-10-23)

### Fixes

- **流式工具调用的名字被重复拼接**（`BashBashBash…`，导致外部客户端报「工具不存在」、请求一直卡住）：宿主 adapter 在**每一个** `tool-call-delta` 上都带着完整的 `id` 与 `name`（`llm-pi-ai` 的 `toolcall_delta` 就是如此），而 OpenAI 客户端会**累积拼接**每个字符串字段，于是 `Bash` 被拼成几十份。现在按「后缀增量」下发：字段没变就发空、只变长就发增量、整段变化才发全量 —— 客户端拼一次正好等于一个正确的名字与一个调用 ID。非流式路径同样按该规则合并。
- 新增回归检查：以真实 adapter 的重复行为驱动流式工具调用，断言按 OpenAI 语义拼接后 `name` / `id` / `arguments` 各只有一份；并验证 `tool` 结果消息带回 `tool_call_id` 后仍被正确翻译。

## 1.0.0 (2026-10-23)

首个公开版本。把已经配置在 DeepSeek Harness 里的**全部 provider、全部模型**暴露成一个固定的 OpenAI 兼容接口，并提供侧边栏页面管理端口、密钥与模型清单。

### Added

- **OpenAI 兼容接口**：`GET /v1/models`、`GET /v1/models/<provider>/<model>`、`POST /v1/chat/completions`、`POST /v1/completions`、`OPTIONS /v1/*`（CORS 预检，无需鉴权）。
- **按 `provider/model` 命名** —— 一个裸模型 ID 在只有一个 provider 提供时同样可用；多个 provider 撞名时返回候选列表而不是猜一个。
- **翻译层**：`system` / `developer` 折进 system 提示；`user` / `assistant` / `tool` 转成 LLM 消息块；`tools` 转函数声明；`tool_calls` 分片拼装完整并回到 `tool_call_id`；`reasoning_content` 单独返回；`usage` 映射为 `prompt_tokens` / `completion_tokens` / `total_tokens`（含 reasoning / cache 细分）。
- **`reasoning_effort` 按目标模型声明的档位映射**，不支持的档位降级或丢弃，不拒请求。
- **`stop` 降级**：上游返回 `UNSUPPORTED_OPTION` 时去掉 `stop` 重试一次。
- **固定端口**（默认 `8787`，只绑 `127.0.0.1`）：与界面端口解耦，重启不变；启动时端口被占用自动落到随机端口继续服务并在页面标明；页面可即时改端口，被占用时返回 `409` 且继续在原端口服务。
- **固定密钥**：`sk-dsh-…` 落在 `$DSH_HOME/openai-gateway/settings.json`（0600），跨重启不变；页面 **生成** 可轮换（两步确认）。自动迁移旧版 `api-key` 文件。
- **侧边栏「模型网关」页**（`sidebar.panellist` + `main` 面板）：接口地址、密钥（打码 / 显示 / 复制）、端口编辑、按 provider 折叠的完整模型清单，支持单个 / 整组 / 全部复制。
- **控制接口**：`GET /plugins/dsh-openai-gateway/status`、`POST …/settings`、`POST …/key`，要求同源 + `POST` + JSON Content-Type，且状态文档自带完整模型清单（页面只发一个同源请求）。

### Compatibility

1.0.0 在以下 provider 插件上实测通过（真实凭据、真实上游）：

- **`@opencode2dsh/dsh-plugin`**（provider `opencode2dsh`）—— 免费额度模型，如 `opencode2dsh/deepseek-v4.1-flash-free`（阻塞与流式均验证）。
- **`dsh-connect-workbuddy`**（provider `workbuddy`、`workbuddy-global`）—— 如 `workbuddy/deepseek-v4.1-flash`；账号池换号时上游注入的提示原样透传。
- **`dsh-workbuddy-xdpool`**（provider `workbuddy-xdpool`）—— 同样经 `ctx.llm` 路由，无需适配。
- **`@deepseek-ai/dsh-llm-pi-ai` 的本地路由**（provider `local`，例如指向 Ollama 的 `qwen3.5:4b`）。
- **DSH 内置 DeepSeek provider**（`deepseek-official`、`deepseek-account`）。

网关不按厂商写转发逻辑：它只读 `ctx.llm` 已注册的 provider，因此任何把 provider 注册进 `ctx.llm` 的插件都自动可用。上游需要的请求头由各 provider 自己的 adapter 负责，网关不额外拼装。

### Known limits

- 外部客户端不能传图片与文件（会话外拿不到可持久化的附件引用），只转发文本。
- 只绑 `127.0.0.1`，不是网络服务。
- 没有 web server 的 profile 无页面与控制接口，但 `/v1/*` 仍按固定端口提供服务。

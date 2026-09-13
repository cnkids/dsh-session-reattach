🌏 [English](README.en.md) · **中文**

<h1 align="center">dsh-session-reattach</h1>

<p align="center">
  <strong>把游离（未分组）会话按 cwd 送回它该在的工作区</strong><br>
  只改归属记录 · 不碰会话文件 · 默认 dry-run
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat" alt="Node.js 20 or newer">
  <img src="https://img.shields.io/badge/DSH-plugin-4D6BFE?style=flat" alt="DeepSeek Harness plugin">
  <img src="https://img.shields.io/badge/%E9%9B%B6%E4%BE%9D%E8%B5%96-0%20deps-2EA44F?style=flat" alt="Zero runtime dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
</p>

<p align="center">
  <a href="#特性"><strong>特性</strong></a> ·
  <a href="#用法">用法</a> ·
  <a href="#安装">安装</a> ·
  <a href="#快速上手">快速上手</a> ·
  <a href="#判定规则">判定规则</a> ·
  <a href="#安全边界请如实理解">安全边界</a> ·
  <a href="#与同类插件的差异">与同类插件</a> ·
  <a href="#常见问题">常见问题</a> ·
  <a href="#开发">开发</a>
</p>

---

> 会话被移动过、或在工作区还不存在时就创建过之后，它可能永远回不到任何工作区分组里 ——
> 侧边栏里只剩一个「未分组」。这个插件补上那个缺失的入口：把会话拖进它该在的工作区文件夹。

## 名字

**reattach**（重新归属）：会话文件一个字节都不动，只把 `workspace.json` 里那份**归属记录**改对。
之所以叫「归位」而不是「移动」，是因为**它做不到任意移动** —— 见[判定规则](#判定规则)：
DSH 只接受 `cwd` 与工作区目录完全一致的归属，所以这个插件能把会话送回**它本来就在的那个目录**，
但不能把它迁到别的目录去。

## 特性

- **补的是 DSH 的一个真实空白** —— `Workspace.attachSession` 只在**新建会话 / 新建子代理**时被调用；历史会话的自动收养在 `WorkspaceRegistry` 初始化时**只跑一次**（`initialized` 落盘即永不再跑）；而全部 `@Remote(...)` 端点里**没有任何 attach 类方法**。于是「会话移动过 ⇒ 永久游离」没有任何修复入口，本插件就是那个入口。
- **只改归属，不碰会话文件** —— 不做任何文件写入，会话日志（`session.jsonl.zstd`）与首帧 `cwd` 都不动。与「改会话首帧 `cwd` 把自己挂到别处」是两条路。
- **写入权威只有 DSH** —— 归属校验与落盘全部走 `Workspace.attachSession` / `detachSession`；插件自己不做路径判定以外的任何决定，也不直接写 `workspace.json`。
- **先清后挂** —— 归位前先从**其余**工作区清掉该会话的陈旧槽位。这不是洁癖：`attachSession` 不复核别的工作区，而 registry 启动校验会因为同一会话被两个工作区记账而**直接抛错、整个工作区域不可用**；顺序错了就会踩这个坑（审计已证实）。
- **同 canon 判定** —— 用 `fs.realpath` 把会话 `cwd` 与工作区 `path` 归一到同一套 canon 再比较：尾斜杠、`..`、符号链接、大小写差异都不会误判；判定结果与真实 `WorkspaceEntity` **逐条一致**（审计逐条比对过）。
- **默认 dry-run** —— 只有显式 `"dryRun": false`（或命令里写 `apply`）才写入；`"false"` 字符串、`0`、`null`、`[]` 一律仍是 dry-run。
- **拖拽时只高亮合法落点** —— 开始拖动的那一刻就算出该会话唯一能去的工作区（浏览器侧用 `SessionSummary.cwd` 预筛），只有那个分组接受放置；其余分组显示禁止光标。判断只作提示，**最终以宿主判定为准**。
- **失败关闭** —— 清槽位失败就放弃 attach（绝不冒双归属的险）；会话数量超上限会**明说**「还有 N 个更早的会话未参与判定」，不假装看全了；上游改了侧边栏结构就整体静默（什么都不做，绝不写错数据）。
- **零运行时依赖** —— 不 import 任何 DSH 包，也不装任何第三方包，只用 `ctx` 上的服务；纯 JS 全平台可用。

## 用法

| 入口 | 作用 | 怎么触发 |
| --- | --- | --- |
| 拖拽 | 把「未分组」里的会话拖进它该在的工作区分组 | 侧边栏里直接拖；cwd 匹配的分组会亮虚线框 |
| `/reattach` | 只报告：将归位哪些会话、哪些不能归位及原因 | 输入框敲，**不经过模型** |
| `/reattach apply` | 执行归位 | 同上 |
| `/reattach apply subagents` | 连带处理子代理会话（默认跳过） | 同上，参数可任意顺序 |

拖到别的分组不会被写入（禁止光标）。若该会话**本来就不在可归位集合里**（cwd 已失效、没有对应工作区、已归档……），插件不猜原因，而是放行落点、请宿主给出准确结论，再用右下角提示条显示 —— 所以你看到的一定是真实原因。

`/reattach` 是纯宿主命令：不消耗 token、不受模型判断影响，也是拖拽万一失效时的兜底通道。

下面是示例（**分类口径与数字取自一次真实 dry-run**：78 个会话、10 个工作区）：

```text
会话归位 · dry-run（未写入任何内容）

可归位 2 个：
• session-xxxx → 「team-manage」（/Users/me/Project/team-manage）
• session-yyyy → 「dsh-palimpsest」（/Users/me/Project/dsh-palimpsest）

无匹配工作区 1 个：
• session-zzzz：/Users/me/Downloads

cwd 无法校验 1 个：
• session-wwww：cwd 已失效（目录被移动、改名或不可访问）（/Users/me/old-project）

跳过：已归档 39 个、子代理会话 11 个
已归属、无需动作：26 个

执行：/reattach apply，或把会话直接拖进侧边栏里对应的工作区分组。
```

## 安装

### 从 npm / GitHub

```sh
dsh plugin --profile web add dsh-session-reattach
# 或
dsh plugin --profile web add github:cnkids/dsh-session-reattach
```

### 从本地路径（开发中）

在插件目录下执行（`link:` 会让源码改动直接生效，不必每次重装）：

```sh
dsh plugin --profile web add "link:$(pwd)"
```

安装命令会把依赖写进 profile 的 `package.json`，并把声明了 `dsh.bundle` 的包追加进 `dsh.profile.bundles`。

**装完必须重启 `dsh web`** —— 宿主插件由 cordis loader 在启动时装配，本机 profile 没有开 `patchReload: live`，`hmr` 在 `dsh-base` 里默认 `disabled: true`。

本插件是 **web profile 专用**：宿主半边需要 `webServer` 与 `connection` 两个服务（后者由 `dsh-client-connection` 的宿主半边提供）。缺任意一个，cordis 会把插件停在「等待依赖」而不启用 —— 这是刻意的失败关闭，不会留下一个没有守卫的写入端点。

## 快速上手

装好重启后，先看一眼有没有要修的（**这一步不写任何东西**）：

```text
/reattach
```

确认列表没问题再执行：

```text
/reattach apply
```

日常更省事的是直接拖：在侧边栏展开「未分组」，按住某个会话行开始拖动，**cwd 匹配的那个工作区分组会立刻亮起虚线框**，拖进去松手即可 —— 右下角提示条会告诉你结果，侧边栏自动刷新。

## 判定规则

**匹配 = `realpath(会话头 cwd) === workspace.path`**

工作区 `path` 在建记录时就已是 `fs.realpath` 的结果（无尾斜杠、无 `..`、符号链接已解开），所以两端都走 realpath 才是同 canon 比较。以下写法**都算匹配**（会被归一掉）：`/work/`、`/work/.`、`/work/sub/..`、指向同一目录的符号链接，以及大小写不敏感卷上目录名的大小写差异。

匹配不上的五种成因，各有独立文案：

| # | 成因 | 归类与提示 |
| --- | --- | --- |
| 1 | 会话头没有 `cwd` | 跳过：无法校验 |
| 2 | `cwd` 不是绝对路径 | 跳过：非绝对路径 |
| 3 | 目录已删 / 改名 / 不可访问 | 跳过：`cwd` 已失效 |
| 4 | 路径存在但不是目录 | 跳过：不是目录 |
| 5 | 能解析、是目录，但与该分组的 `path` 不同 | **拖错分组**：该目录属于另一个工作区就点名「只能归位到 X」；没有任何工作区记录该目录则提示先在侧边栏为它创建工作区 |

**为什么不做任意迁移**：DSH 的 `attachSession` 会拒绝 `cwd` 与工作区目录不一致的归属，这是宿主的硬校验，不是本插件的限制。所以拖拽在这里的语义是「把它送回它本来就在的那个文件夹」。

## 安全边界（请如实理解）

这是一条**会写工作区归属**的通道，所以边界要说清楚，而不是笼统说「安全」：

1. **请求信任** —— 路由与 `/api` 用的是**同一套**守卫：`Host` 必须是回环或受信、`Origin` 存在时必须与 Host 同源、`Sec-Fetch-Site: cross-site` 直接拒，之后还要过浏览器认证。实测未认证 / 跨源 / `Origin: null` / 伪造 Host 一律 401/403，且**先拒绝、后不解析业务体**（审计对运行中的宿主实测）。
2. **默认不写** —— 只有显式 `"dryRun": false` 才落盘；类型混淆打不开这个开关。
3. **失败关闭** —— 清槽位失败就放弃 attach；计划数据形状不对时前端不猜落点；上游改了侧边栏 DOM，拖拽整体静默。
4. **不越权** —— 只用 `attachSession` / `detachSession`，不写文件、不起子进程、不联网。

**说清楚代价与做不到什么**：

- **它会 mutate 非目标工作区**：归位一条会话时，插件对每个非目标工作区调用一次 `detachSession`；DSH 的 `mutate` 会顺带**持久剪枝**该工作区里「已索引 cwd 与记录不符」的候选。剪枝判据是**持久事实**（会话头没有 cwd、或 cwd 解析到别处），不是「目录暂时不可达」，所以外置卷临时卸载不会掉归属；而被剪掉的会话在目录恢复后会被本插件重新归位。**不这么做**的替代方案是留下双归属，让下次启动 `validateStoredState` 直接抛错。
- **它靠侧边栏的结构工作**：会话行锚点 `[role="treeitem"][aria-selected]`、工作区分组行锚点 `[role="treeitem"][aria-expanded][draggable="true"]`，以及内置 `onDragStart` 把会话 id 写进 `dataTransfer` 的 `text/plain` 这一行为。上游改了其中任何一处，**拖拽会静默失效**（识别不到就什么都不做），`/reattach` 命令不受影响。
- **分组靠标题匹配**：DOM 行不携带工作区 id，只能按可见标题匹配。标题重复时可能高亮到同名的另一个分组 —— 那种情况下宿主仍会拒绝并给出「只能归位到 X」，最坏结果是一句明确报错。
- **`/state` 的成本与调用方相同源**：每次请求对每个会话做 `realpath` + `stat`（本机 78 会话约 10 ms 量级）。宿主侧刻意不加缓存（缓存会把刚变化的归属喂给写入判定，让一次合法归位变成失败）；调用方必须已认证，而同源脚本本就能调 `/api` 做成本更高的事。

## 与同类插件的差异

这个方向上的常见做法是「会话移动器」（拖拽迁移、批量操作、回收站、分组合并），本插件的取舍是**只做归位**：

| | 本插件 | 移动器类插件 |
| --- | --- | --- |
| 能力 | **只重新归属**：把 `cwd` 有效但没被记账的会话挂回匹配的工作区 | 任意跨工作区迁移、批量、回收站、分组 |
| 会话文件 | **不碰**（不重写首帧 `cwd`） | 常需改写会话首帧或搬动会话目录 |
| 允许的落点 | 只有 `cwd` 与工作区目录**完全一致**的那一个（宿主硬校验） | 由插件自己定义，通常任意 |
| 写入面 | 两个已存在的宿主 API（`attachSession` / `detachSession`） | 自建存储 / 索引与迁移逻辑 |
| 运行时依赖 | **零**（不 import 任何 DSH 包） | 常见对 DSH 内部包的直接依赖 |
| 安全审计 | 有（8 条 PoC：真 socket、真实 `WorkspaceEntity`、运行中宿主的守卫探测；产物不随仓库分发） | 未见 |

**与 `dsh-palimpsest` 的关系（一处常见误判）**：`palimpsest` 的硬范围**只比对会话头 `cwd`**，候选来自 `sessionQuery.listSessions()`（live + 全部持久化会话），**与工作区归属无关**。所以一个「未分组」会话只要 `cwd` 等于当前会话的 `cwd`，`palimpsest` 今天就能读到它 —— 本插件修的是**侧边栏分组与工作区记账**，不是 `palimpsest` 的可见性。两者解耦，不需要为彼此改一行代码。

## 常见问题

**装完没反应？** 必须重启 `dsh web`（宿主插件只在启动时装配）。重启后 `/reattach` 应出现在命令面板里。

**拖不动 / 拖进去没反应？** 先确认那个会话的 `cwd` 对应的目录**存在且是目录**；目录已删的会话只能在报告里看到「cwd 已失效」。如果是**上游改了侧边栏**导致拖拽整体失效，用 `/reattach`（功能不受影响），并在 issue 里带上你的 DSH 版本。

**拖错分组会怎样？** 不会写错。cwd 不匹配的分组不接收放置；万一同名标题让它放行了，宿主仍会拒绝并提示「只能归位到 X」。

**会不会动我的会话？** 不会。插件只调用 `attachSession` / `detachSession` 改归属，会话日志与首帧 `cwd` 一个字节都不改。

**为什么不能把会话移到别的项目？** 因为 DSH 只接受 `cwd` 与工作区目录完全一致的归属。想换项目，得先改会话首帧 `cwd`（那是另一类工具的事），本插件刻意不碰文件。

**子代理会话要不要一起归位？** 默认跳过（它们嵌在父会话下，单独归位收益低）。需要时用 `/reattach apply subagents`。

**已归档的会话为什么不动？** 归档会话在侧边栏本就不可见，而且归档**不会**摘掉归属槽位，所以没有补写的必要。

**没有对应工作区的会话怎么办？** 插件只报告、不创建（职责边界就是「归位」）。按提示先在侧边栏为那个目录创建工作区，再归位。

**会不会拖慢 DSH 启动？** 不会。插件不做任何启动期扫描或索引。

**连不上网能用吗？** 可以。插件不联网、零运行时依赖。

**为什么叫 reattach？** 见[名字](#名字)。

## 开发

```sh
npm test                       # 121 个用例：纯逻辑单测 + 宿主装配 + HTTP 真 socket + 浏览器半边行为
npm run coverage               # 同上，并生成 coverage/lcov.infonode scripts/build-client.mjs  # 改了 client-core.js / client-dom.js 后必须重新生成
```

覆盖率（Node 内置统计）：行 99.60%、函数 99.13%、分支 96.24%。

**改了 `lib/client-core.js` 或 `scripts/client-dom.js` 一定要重新生成 `lib/client.js`**；忘记生成会让 `test/client.test.mjs` 的漂移检查失败。浏览器端 bundle 必须是 classic script（内置模块系统用 `<script src>` 加载），既不能写 `import` / `export`，也不能被 Node 直接 import —— 这就是「纯逻辑单独成模块 + 生成」的原因。

**安全审计**：8 条可独立运行的 PoC（真 socket 的 413/HTTP 语义、与真实 `WorkspaceEntity` 的逐条比对、以及针对运行中宿主的守卫探测）在仓库外维护，**不随仓库分发**；结论已并入上文「安全边界」。

**SonarQube**：

```sh
npm run coverage        # 先产出 coverage/lcov.info，否则覆盖率是空的
npm run sonar           # = ./scripts/sonar-check.sh，分支自动取当前 git 分支
npm run sonar -- main   # 显式指定分支
```

令牌绝不写进仓库。本机约定是在 `~/.zshrc` 里按项目放一个变量：

```sh
export SONAR_TOKEN_DSH_SESSION_REATTACH=sqp_xxxxxxxx
```

`scripts/sonar-check.sh` 会优先取它并映射成 `SONAR_TOKEN`，未设置时回退通用 `SONAR_TOKEN`；脚本还负责分支与版本号（不带 `sonar.branch.name` 时结果会写进 SonarQube 主分支）。

**代码结构**：`lib/core/` 是不依赖 DSH 的纯逻辑（路径 canon、计划、执行、渲染），`lib/host.js` 是与 `ctx` 的唯一接触面，`lib/http.js` 与 `lib/command.js` 是两个入口，`lib/index.js` 是插件入口；浏览器半边是 `lib/client-core.js` + `scripts/client-dom.js`（生成 `lib/client.js`）。

**HTTP 契约**（供二次开发与排查）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/session-reattach/state` | 工作区清单 +「可归位会话 → 目标工作区」映射，供前端预筛落点 |
| `POST` | `/session-reattach` | 体 `{dryRun?, sessionId?, workspaceId?, includeSubagents?}`；不写 `dryRun` 即 dry-run |

`single.code` 取值：`ok` / `already-accounted` / `cwd-invalid` / `no-workspace` / `workspace-mismatch` / `workspace-not-found` / `session-live` / `session-archived` / `session-subagent` / `session-not-found`；内部故障一律 `internal-error`（细节只进宿主日志）。

### 发布（npm + GitHub Actions）

`v*` tag 由 `.github/workflows/release.yml` 接管：校验 tag 与 `package.json` 版本一致 → `npm ci` → `npm audit` → `npm test` → `npm publish --provenance`（**OIDC，无需任何 token secret**）→ 建 GitHub Release 并附 `.tgz`；`main` 推送与 PR 由 `ci.yml` 跑同一套测试与审计。

**首次发布必须先手工做一次**：npm 没有 `pending publisher`，包在 registry 上不存在时**无法配置 Trusted Publisher**（会得到误导性的 `404 … is not in this registry`）。顺序是：

```sh
# ① 手工首发（会要 2FA 或一个启用了 bypass-2fa 的 granular token）
npm login
npm publish --access public

# ② 到 npmjs.com 的包设置里配置 Trusted Publisher → GitHub Actions：
#    组织/用户 = cnkids   仓库 = dsh-session-reattach
#    工作流文件名 = release.yml
#    环境 = 留空（发布 job 不引用 environment，两边必须一致，否则 OIDC 声明不匹配）

# ③ 推仓库与 tag；首个 tag 会在「已存在同版本」时**跳过** npm 步骤并照常建 Release
git remote add origin git@github.com:cnkids/dsh-session-reattach.git
git push -u origin main
git tag v0.1.1 && git push origin v0.1.1
```

从**下一个版本**开始，trusted publishing 才真正接管：改 `package.json` 版本 → 同步本文件版本记录 → 提交 → `git tag vX.Y.Z && git push origin vX.Y.Z`，CI 直接发布（provenance 自动附带）。

三个容易踩的点（都是实测教训，不是理论）：

- **`npm ci` 需要 `package-lock.json`** —— 本仓库零运行时依赖，所以 lockfile 很小，但必须有（`poc8` 会断言它在）。
- **Trusted Publishing 要求 npm ≥ 11.5.1**，而 Node 22 自带 npm 10.x；版本不够时 `npm publish` 会返回**误导性的 404**。发布 job 因此固定 `npm install -g npm@11.5.1`。
- **发布 job 不引用受保护环境**：`environment` 的审批门在 GitHub 侧故障时会卡死发布；npm 侧的 Environment 也必须**留空**才能与之一致。发布靠 OIDC 短时令牌 + provenance 兜底。

## 版本记录

| 版本 | 变更 |
| --- | --- |
| **0.1.1** | 安全审计落地：体积超限不再拆连接（413 必达）、路由加错误边界（宿主故障回可诊断的 JSON 500 而不是空 400）、会话数量截断如实上报（不再谎报「没有可归位的会话」）；完成安全审计（8 条 PoC：真 socket、真实 `WorkspaceEntity`、运行中宿主的守卫探测；产物不随仓库分发）；README 按 `dsh-palimpsest` 版式重排并补安全边界；用例 105 → 121 |
| **0.1.0** | 首个版本：宿主侧归位核心（realpath 同 canon 判定、五类分类、先 detach 后 attach）、HTTP 路由（复用 `/api` 守卫、默认 dry-run）、`/reattach [apply] [subagents]` 命令、浏览器半边拖拽落点（预筛高亮 + 提示条）、零运行时依赖 |

## 许可证

[MIT](LICENSE)

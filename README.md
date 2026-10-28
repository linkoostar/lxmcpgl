# lxmcpgl — 方中 MCP 网关

多上游 MCP 聚合中转网关：领星 ERP（元工具模式 `help → search → action`，289+ 业务工具）、西柚（广告/ABA 分析）、SIF（市场/流量）、NocoDB（数据层）等统一接入，对外以标准 MCP streamable HTTP 暴露。

**v1.2.0** — 正式生产就绪版本。核心安全加固 + 透传原则收尾 + token 优化。

## 设计原则（重要）

**一条判据：如果上游修好之后这段代码需要跟着改，它就不该在网关。**

网关只做四件事，其余一律透传：

| 能力 | 为什么属于网关 |
|------|----------------|
| **协议转换** | 领星元工具模式嵌套 `{toolId, params}`、标准扁平 MCP、REST 风格参数——不同上游有不同协议层，网关存在的基础就是抹平这些差异 |
| **错误通道归一** | 领星等上游用 HTTP 200 包装业务错误（外层 `success:true code:1`，内层才藏 `success:false code:0 msg:"参数非法"`），MCP 有标准错误通道（`isError:true` + 错误信封），这是协议适配不是数据加工 |
| **只读裁剪** | 运营用户白名单之外的工具不可见/不可调，write 类工具对运营默认拦截——安全边界，只有网关能守 |
| **可观测性** | `upstream_code` 回填上游原始码、`trace_id` 贯通全链路、调用日志入库 + CSV 导出 + Credits 追溯——只有网关能看到上下游全貌 |

**明确不做**：
- ❌ 响应数据加语义标记（如 `is_placeholder_row`、`_formulas`）
- ❌ 本地维护上游参数枚举清单（如 length 只能是 20/50/100...）
- ❌ 改上游字段名、改上游排序、改上游返回值
- ❌ 推断业务含义（汇总行识别、币种判断、空壳检测 → 已降级为 __gateway_warn 日志提示，不拦截）

上游给什么就透传什么，只在协议层做正确的错误转换。

## 核心能力一览

| 能力 | 说明 |
|------|------|
| **协议转换** | 领星元工具模式嵌套 `{toolId, params}` 自动处理；flat-mcp（西柚/SIF/NocoDB）直接透传；URL query 认证（如 SIF `?secret-key=`）、API Key header、自定义 headers 三种认证方式自动识别 |
| **错误通道归一** | 领星双层响应（外层 `success:true code:1` 掩盖内层 `success:false code:0`）→ 挖到 MCP `isError:true`；西柚等 HTTP 风格 `status≥400 + error:true` → 同样归一，带 `upstream_code` / `trace_id` |
| **只读裁剪** | write 工具对运营默认拦截（block_write=1），需管理员手动例外才能放行 |
| **店铺隔离（仅领星）** | `adapter=lingxing-meta` 强制 shop_scoped — 递归提取所有层级/数组内的店铺字段（`sid / sids / store_id / profile_id / seller_id` 等），四种 ID 映射到 sid 后 every 校验，fail-closed 拒绝非白名单店铺调用 + 响应裁剪 |
| **Token 优化** | schema 最小化（丢 description/title/pattern/additionalProperties/$defs，保留 type/enum/required/items 递归）+ description 截断 300 chars → tools/list 从 ~80K tokens 降到 ~69K tokens（-14%） |
| **可观测性** | `upstream_code` 回填上游原始码、`trace_id` 贯通全链路、调用日志入库 + CSV 导出 + Credits 追溯 |
| **安全** | 下游 Key 随机生成 + SHA-256 存储 + 每次请求查库；管理员 Key 设置页默认 masked 显示 + 👁 按需明文；店铺校验 fail-closed 兜底；SQLite 用预编译语句 |
| **Web 管理后台** | 上游配置 + 连通测试 + 工具同步启停；下游 Key 管理 + 店铺同步；工具列表筛选 + 批量启停 + 批量 write 分配；调用日志浏览 + CSV 导出 |
| **定期同步** | `PERIODIC_SYNC_INTERVAL_MS` 驱动定时全量 sync + schema hash（canonicalize 后 SHA-256 前 16 位）对比；领星 code=102 自动刷新 schema 重试 |

## 多上游接入

| 上游 | adapter | 工具数 | 认证方式 | 店铺隔离 |
|------|---------|--------|----------|----------|
| 领星 fangzhong-mcp | `lingxing-meta` | 289（212 read + 87 write） | API Key header | ✅ 强制 shop_scoped |
| 西柚 | `flat-mcp` | 58 | API Key header | ❌ 跳过（公共数据源） |
| SIF | `flat-mcp` | 34 | URL query `?secret-key=` | ❌ 跳过（公共数据源） |
| NocoDB | `flat-mcp` | 按需 | 自定义 headers | ❌ 跳过 |

> flat-mcp 上游的接入：在 Web 后台「上游配置」新增，选 adapter=flat-mcp，填 URL。URL query 里有 `key/token/secret/auth/access/api_key` 等关键词时自动识别为 URL 认证（api_key 字段留空即可）。

## 快速开始（群晖等 Docker 环境）

```bash
docker run -d --name lxmcpgl --restart unless-stopped \
  -p 8080:8080 \
  -v /volume1/docker/lxmcpgl/data:/app/data \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=请修改我 \
  -e LINGXING_MCP_URL=https://openmcp.lingxing.com/mcp-servers/lingxing-mcp \
  -e LINGXING_MCP_KEY=你的领星X-Mcp-Key \
  ghcr.io/linkoostar/lxmcpgl:latest
```

或使用 [docker-compose.yml](docker-compose.yml)：

```bash
mkdir -p data && docker compose up -d
```

> 环境变量仅在**首次启动**写入数据库，之后以 Web 后台配置为准；`/app/data` 必须持久化（SQLite 数据）。

## 首次使用流程

1. 浏览器打开 `http://<NAS-IP>:8080`，用 `ADMIN_USERNAME / ADMIN_PASSWORD` 登录（默认 `admin / admin123`，登录后请立即改密）
2. 「系统设置」→ 填写领星 MCP 地址与 `X-Mcp-Key` → **测试连通**（应显示 `lingxing-mcp-abstract-poc`）
3. 「工具列表」→ **同步工具**（全量拉取 289 个工具 + 入参 Schema，约 5 秒）
4. 「运营用户」→ 创建运营账号，发放独立 Key（弹窗一次性显示，请立即保存）
5. 「系统设置」→ 复制**下游接入配置**发给运营，或需要时**重置 Key**

## 运营用户与权限

「运营用户」页可创建多个运营账号，每个账号独立 Bearer Key（数据库只存 SHA-256 哈希）、可单独停用 / 重置 / 删除、限速（次/分钟）。点「权限」可为每个账号配置：

- **工具白名单**：全部工具（需注意：`admin123` 默认模板只填 read 类）或自定义勾选（支持搜索、全选、清空）；白名单外的工具在 `tools/list` 中不可见，调用也会被拒
- **店铺白名单**：全部店铺 或 自定义勾选（先在「系统设置」→「同步店铺」拉取领星店铺，从 `get_my_sids` + `ad_auth_shops` 双接口补全 `sid / seller_id / store_id / profile_id` 四值域）；调用时递归提取所有层级/数组内的店铺字段，映射到 sid 后 every 校验，未授权店铺直接拒绝
- **写操作管控**：全局默认开启（`block_write=1`），运营不能调用任何 write 类工具。需开放某一个时，在工具权限里**手动勾选**即可放行（不影响其他 write 工具）。write 类型来自上游标记，缺失时按工具名动词归类，可在工具列表查看每行的类型标签

管理员通用 Key（系统设置页）拥有全部工具与店铺权限，不受白名单和写管控限制。**设置页默认 masked 显示，点击 👁 才显示明文**。

## 工具列表批量操作

289 个工具逐个点开关太费时，工具列表页支持：

- **本页全选**：表头复选框勾选/取消本页 50 行
- **全选搜索结果**：按当前搜索词跨页选中全部匹配工具（如搜 `ad` 选中所有广告类）
- **批量启用 / 批量停用**：对选中集合一键生效；也可配合搜索词按条件整体启停
- 点击行复选框可自由增减选中集合，批量栏实时显示已选数量

## 运营接入（Trae / 其他 MCP 客户端）

```json
{
  "mcpServers": {
    "lingxing-gateway": {
      "type": "streamableHttp",
      "url": "http://<NAS-IP>:8080/mcp",
      "headers": { "Authorization": "Bearer <网关下发的 Key>" }
    }
  }
}
```

也支持 `X-Mcp-Key` 头传 Key。未授权请求返回 401。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8080` | 监听端口 |
| `DATA_DIR` | `/app/data` | SQLite 数据目录（务必挂载持久化） |
| `ADMIN_USERNAME` | `admin` | 初始管理员 |
| `ADMIN_PASSWORD` | `admin123` | 初始密码（仅首次生效，之后网页改密） |
| `LINGXING_MCP_URL` | 领星官方地址 | 上游地址（仅首次生效） |
| `LINGXING_MCP_KEY` | 空 | 领星 X-Mcp-Key（仅首次生效） |
| `LX_COOKIE_SUFFIX` | 端口号 | 管理后台 session cookie 后缀，同域名多实例**必须设不同值**（如 `prod1` / `gray`），否则互相踢下线 |
| `PERIODIC_SYNC_INTERVAL_MS` | `0`（关闭） | 定期全量同步上游工具定义 + hash 对比；设为 `600000` 即每 10 分钟同步一次 |

> 以上环境变量中，`LX_COOKIE_SUFFIX` / `PERIODIC_SYNC_INTERVAL_MS` 每次启动时读取（运行时可改）；其余几个仅首次启动写入数据库，之后以 Web 后台配置为准。

## 从源码构建

```bash
npm ci
npm run build
npm start
```

镜像为多阶段构建（builder `node:22-bookworm` / runtime `node:22-bookworm-slim`，x86 与 ARM 均可运行）。

## CI 发布

`.github/workflows/docker.yml` 在推送到 `main` 或打 `v*` 标签时自动构建并推送镜像：

- `ghcr.io/linkoostar/lxmcpgl:latest`（main 分支）
- `ghcr.io/linkoostar/lxmcpgl:1.x.y`（对应 tag）
- 平台：`linux/amd64` + `linux/arm64`

> 首次发布后，ghcr 包默认 **private**：到 GitHub 仓库 → Packages → 该包 → Package settings → 改为 Public（或拉取方 `docker login ghcr.io`）。

## 生产部署安全 Checklist

| # | 项 | 严重度 | 说明 |
|---|------|--------|------|
| 1 | 改 admin 密码 | 🔴 必改 | docker-compose 默认 `admin123` |
| 2 | HTTPS 反代 | 🔴 必加 | Cookie 无 Secure，Bearer key 明文传输 |
| 3 | 数据目录权限 | 🔴 必锁 | `chmod 600 ./data/*.db`；明文 SQLite 含所有上游 Key + 下游 Key 哈希 |
| 4 | ghcr.io 换本地 build | 🟡 建议 | 别用 `pull_policy: always` + `:latest`，改成本地 `docker build` 固定 tag |
| 5 | LX_COOKIE_SUFFIX | 🟡 多实例必须 | 同域名多实例**必须设不同值**，否则 session 互相踢下线 |
| 6 | PERIODIC_SYNC_INTERVAL_MS | 🟡 建议 | 设 `600000`（10 分钟）定期同步上游工具定义 |
| 7 | 上游 api_key | 🟡 注意 | URL query 认证的上游（如 SIF）api_key 字段留空，否则自动加 Authorization header 可能触发 401 |
| 8 | 备份加密 | 🟢 建议 | SQLite 数据目录定期备份 + 加密存储 |
| 9 | /health /version 暴露 | 🟢 可选 | 如需隐藏，加 Bearer Key 校验或只绑内部端口 |

## 路线图

- [x] **阶段 1**：中转 + Web 管理
- [x] **阶段 2**：多运营用户（独立 Key / 停用 / 重置 / 限流）、工具白名单、店铺级权限（四值域桥接 + fail-closed）、write 类管控、工具批量启停、上游 Schema 过期（code 102）自动刷新重试
- [x] **阶段 3**：多上游聚合（`lingxing-meta` / `flat-mcp` adapter 路由）、调用日志入库 + 筛选 + CSV 导出、Credits 追溯、双层响应内层业务错误检测、西柚 HTTP 风格 `status≥400 + error:true` 检测、定期同步 + canonicalize hash 对比
- [x] **阶段 4（v1.2.0）**：透传原则收尾（删掉响应数据语义标记、删掉本地 enum 校验、删掉 _upstream* 冗余字段）、schema 最小化 + description 截断 token 优化、block_write 默认禁 + 手动例外、管理员 Key masked、URL query 认证自动识别
- [ ] **阶段 5**：write 操作审批、用量看板、告警、调用记录审计日志
- ~~响应数据语义标记~~（is_placeholder_row / _formulas / 本地 enum 校验等）— **已关闭**，不符合网关设计原则

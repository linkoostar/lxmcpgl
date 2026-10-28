# lxmcpgl — 方中 MCP 网关

多上游 MCP 聚合中转网关：领星 ERP（元工具模式 `help → search → action`，289+ 业务工具）、西柚、NocoDB 等统一接入，对外以标准 MCP streamable HTTP 暴露。

- **真实密钥不出容器**：上游 API Key 只保存在网关数据库中，运营仅接触网关发放的下游 Key
- **多上游聚合**：adapter 路由，领星元工具模式（`lingxing-meta`）和标准扁平 MCP（`flat-mcp`）统一适配；`tools/list` 自动给工具加 `[来自 XX]` 前缀 + 同名冲突加 `upstream__` 前缀
- **业务错误全链路可见**：上游 `upstream_code` 回填原始码（领星 102/403 等包在 content 里的业务错误也能正确识别），统一错误信封带 trace_id；工具定义版本 hash 自动感知变更
- **定期同步**：`PERIODIC_SYNC_INTERVAL_MS` 驱动定时全量 sync + hash 对比，上游悄悄改工具定义提前到位，不等 102 触发才兜底
- **Credits 消耗可追溯**：调用记录表格和 CSV 导出直接带 `Credits` 列，和 `cost_logs` 双写对账
- **Web 管理后台**：上游配置、连通测试、工具同步与启停、下游 Key 管理、调用记录浏览与 CSV 导出
- **已适配细节**：领星 `help` 分页参数为 `offset/limit`；业务调用统一经 `action(toolId, params)`；JSON / SSE 双响应兼容；cookie 名带部署后缀（`LX_COOKIE_SUFFIX`），同域名多实例互不干扰

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

- **工具白名单**：全部工具 或 自定义勾选（支持搜索、全选、清空）；白名单外的工具在 `tools/list` 中不可见，调用也会被拒
- **店铺白名单**：全部店铺 或 自定义勾选（先在「系统设置」→「同步店铺」拉取领星店铺）；调用参数中的 `sid / sids / store_id / store_ids / shop_id / shop_ids / profile_id / profile_ids` 逐一校验，未授权店铺直接拒绝
- **写操作管控**：「系统设置」→「禁止运营用户调用 write 类工具」开启后，write 类工具对运营全部拦截（工具读写类型来自上游标记，缺失时按工具名动词自动归类，可在工具列表查看每行的类型标签）

管理员通用 Key（系统设置页）拥有全部工具与店铺权限，不受白名单和写管控限制。

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

## 路线图

- [x] **阶段 1**：中转 + Web 管理
- [x] **阶段 2**：多运营用户（独立 Key / 停用 / 重置 / 限流）、工具白名单、店铺级权限（同步 `get_my_sids` 店铺、`sid/sids/store_id/profile_id` 等参数校验）、write 类管控、工具批量启停、上游 Schema 过期（code 102）自动刷新重试
- [x] **阶段 3**：多上游聚合（`lingxing-meta` / `flat-mcp` adapter 路由）、调用日志入库 + 筛选 + CSV 导出、Credits 消耗追溯、统一错误信封 `upstream_code` 回填原始码、领星 content 内业务错误检测、定期同步 + hash 对比、cookie 部署后缀隔离
- [ ] **阶段 4**：write 操作审批、响应脱敏、用量看板、告警

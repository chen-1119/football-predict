# A+B 账号、体验和个人关注

此版本不含支付、订单或自动续费。公开内容和会员内容均不改变参考／影子模型等级。

## 数据和权限

迁移 `server/postgres/migrations/012_accounts_and_follows.sql` 新增 PostgreSQL 表：

- `account_users`：真实账号、密码摘要、恢复码摘要、角色、禁用状态、体验领取时间。
- `account_sessions`：随机会话令牌的摘要、到期与撤销时间。
- `account_access_grants`：三天体验、旧码兑换、人工赠时，均用服务器／数据库时间。
- `account_legacy_redemptions`：全局唯一 `code_id`，并发兑换最多成功一次。
- `account_follows`：按用户与比赛事件唯一关注，保存原队名及可选冻结决策引用。
- `account_audit_events`：只追加审计，不保存密码、恢复码或 Cookie。
- `account_auth_rate`：登录、注册、找回、兑换和管理员二次验证限流。

普通用户可在没有内容权益时关注基础赛程、管理自己的关注和查看其正式结果。关注写入不接受客户端指定所有者；不存在的比赛、跨场决策引用被拒绝。正式结果来自现有赛果管线，不用比分或客户端字段推测命中。历史关注不会用当前比赛替换当时队名、版本和 SP。

三天体验由用户主动领取，每个账号一次。到期、重新登录、找回密码均不会恢复领取资格。当前方案是每账号限制，并非已验证手机号或实名个人限制。

角色为 `user`、`operator`、`admin`。注册始终获得 `user`。运营只能为普通用户赠送内容权限；管理员可调整其他账号的状态和角色。后台变更必须输入当前密码、填写理由，并与审计一并提交。禁用或改角色会撤销目标的所有会话。不能修改自己的管理员状态或角色。

## 登录与恢复

账号名为 3–32 位字母、数字、点、减号、下划线，忽略大小写；密码为 15–128 字符，保留空格。密码使用异步 scrypt（N=32768、r=8、p=3），限制并行哈希数。服务端以可撤销的 HttpOnly、Secure、SameSite Cookie 保存登录态，数据库仅保存会话摘要。写请求校验明确站点 Origin 与当前会话的 CSRF Token。

注册成功只展示一次随机恢复码，请离线保存。找回密码需要账号名和恢复码；成功后原码失效、返回新的恢复码、所有旧设备退出，再使用新密码登录。没有短信或邮件服务时不展示发送验证码按钮。

## 首位管理员引导

1. 用户先在网页注册普通账号并保存恢复码。
2. 运维核对需要提升的确切账号名。在已经配置数据库连接的服务器应用环境执行下列命令；将 `your_registered_admin` 替换为核实过的账号名：

```bash
node scripts/bootstrapAccountAdmin.cjs --username your_registered_admin --confirm-first-admin
```

该命令不创建账号、不接收密码，仅在系统不存在任何管理员时提升明确指定且状态正常的已有账号。操作使用事务和管理员变更锁，写入审计并撤销该账号旧会话。账号随后重新登录，在 `/account-admin` 进入体验管理。已有管理员后命令拒绝再次执行；后续角色变更由管理员后台完成。禁止使用“第一个注册的人自动成为管理员”的逻辑。

命令需要受控数据库运维权限。不要把数据库连接串、管理员密码或恢复码写入命令行参数、发布日志或仓库。此文档不意味着已经执行引导。

## API 合同

- `GET /api/account/me`：匿名也可用，返回 `user`、`access`、`authMethods`、`csrfToken`、`sessionExpiresAt`。仅登录／注册成功使用新 Cookie；仅注册成功额外返回 `recoveryCode`。
- `POST register/login/logout/recover/trial/redeem`：路径前缀均为 `/api/account/`。恢复成功仅返回新的恢复码，清除登录态。
- `GET sessions`、`DELETE sessions/:id`、`POST sessions/revoke-others`：只允许本人会话。
- `GET/POST follows`、`DELETE follows/:id`：只允许本人关注，重复关注幂等。每账号最多关注 200 场，达到上限后明确提示先取消部分关注；重复关注仍返回原记录，不覆盖初次冻结引用。
- `GET admin/users`：运营／管理员读取最近 100 个账号。
- `POST admin/users/:id/grant`：`{days:1..365,reason,currentPassword}`，从操作成功时开始赠时，不叠加旧到期时间。
- `POST admin/users/:id/status`：`{status:'active'|'blocked',reason,currentPassword}`。
- `POST admin/users/:id/role`：`{role:'user'|'operator'|'admin',reason,currentPassword}`。

前端使用 `credentials:'include'` 和 `x-csrf-token`；密码和恢复码不写浏览器持久存储。旧访问码兑换只读校验 JSON，由 PostgreSQL 唯一约束落账，避免两个存储之间的半成功写入。原始旧码的到期时间不会延长。“只兑一次”限定为兑换到账号权益；旧共享校验入口及其旧身份在原自然有效期内继续兼容，不与新账号混为同一身份。

## 验证与发布

本地基础验证：`node --test tests/accounts-security.test.cjs tests/account-admin.test.cjs`。

原生 PostgreSQL 验证：`node scripts/verifyAccountsPostgres.cjs`，必须显式提供 `ACCOUNTS_TEST_DATABASE_URL`。脚本仅允许 loopback 的 `accounts_test` 或 `recommendation_test`，不加载生产 `.env`，在独立随机 schema 内验证并发领取／兑换／恢复、越权、禁用、撤销、过期及关注绑定，再删除该测试 schema。

应用接入时明确设置公开 HTTPS Origin，密码功能与公开预览分别使用发布配置开关。反向代理场景只能由已核验的可信代理解析客户端 IP，不能直接信任任意请求自带的 `X-Forwarded-For`。

## 回滚

012 是新增账号数据结构。先部署迁移，再启用应用入口；代码回滚时关闭新功能或切回旧程序，保留所有 012 表、已用体验标记、旧码兑换记录、恢复码摘要和审计。不要删除账号表、清空迁移记录或回退 012 以“重新领取”体验。数据库备份和迁移审计按现有运维流程保留；恢复备份需同时考虑已撤销会话与已兑换权益，避免旧令牌或旧访问码再次有效。

测试账号清理采用禁用账号、撤销会话／权益并追加审计，不删除真实用户、推荐证据或已有审计。

# Cockpit Tools — 保留 Zed 顺序的个人更新渠道

**当前状态：个人更新渠道已启用；仓库包含 Student Hosted AI 探针和 Windows 本地构建入口。**

目标账号：`lml-729`。默认发布仓库：`lml-729/cockpit-tools-zed-updater`。
这个小仓库管理构建配置；每次从官方正式发布版本的固定提交获取完整源码并应用补丁。无需复制、合并官方的所有工作流。

## 一次性配置

这个仓库已经由助手配置，不需要运行 Deploy.ps1。该脚本仅供新仓库的独立部署参考，拒绝覆盖已有仓库。

从 [v1.3.63 发布页面](https://github.com/lml-729/cockpit-tools-zed-updater/releases/tag/v1.3.63)下载并安装一次 `x64-setup.exe`。退出旧的便携版，从安装版快捷方式启动。后续使用客户端的“检查更新／更新”，或开启原有自动安装更新选项。

构建需要以下专用配置：

- Actions Variable：`TAURI_SIGNING_PUBLIC_KEY`（客户端校验公钥）。
- Actions Secrets：`TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（加密私钥及密码）。

私钥和密码不得提交到仓库或上传到 Release。丢失它们后，已有客户端无法信任用新密钥签名的更新。

## 自动更新流程

- 每小时第 23 分钟检查官方最新正式 Release；GitHub 调度可能延迟，不承诺官方发布后立即可用。
- 以官方 Release 对应的固定 commit 构建，保留原作者署名与许可。
- 在 Zed 页面移除当前账号置顶；同值账号按固定 ID 比较。
- Student 计划通过最多 1 个输出 token 的 Anthropic 请求检查 Hosted AI。有效账号仍有极小的输入和输出用量；获取 LLM token 或模型列表成功不代表剩余额度可用。
- 按 Zed 官方协议读取完整逐行 JSON，处理流中的 `status.failed` 和提供方 `error`；只有完整成功响应才显示可用。
- 明确的学生额度错误显示“Student 额度已用完”；普通权限错误显示“权限不足”，网络失败、HTML、截断和限流保持未知。
- 旧探针缓存和导入快照不视为当前可用性证明；导入后请刷新账号。可用性是检测时刻的结果，不代表美元余额。
- 从实际页面提取排序回调，覆盖排序方式、升降序、当前账号以及后台返回顺序，共 72 个场景。
- 官方结构变更导致补丁或验证失败时，停止构建/发布，保留上一个可用版本。
- 客户端唯一更新地址指向个人仓库的 `latest.json`，不回退到官方未修改包。
- 生成 NSIS 安装包和其签名，先上传为草稿，再发布完整 Release，避免客户端读到不完整更新。
- 程序版本跟随官方版本；同一官方版本下构建相关定制改变时，以递增的 `-cockpit.N` 版本发布，确保客户端可以识别更新。
- 每 30 天更新一次监控时间文件，维持仓库活动，减少公开仓库长期无活动导致定时任务停用的情况；平台故障、账号限制、维护冲突仍可能需要处理。

自动更新功能沿用官方已有界面。没有另建账号数据库，也没有打包任何 Zed 凭据。
使用 Zed 时选择“按创建时间”，保持逐号使用顺序；金额/账期排序仍会随真实字段变化。

## 验证与限制

本地验证包括 JavaScript/YAML 语法、在当前官方源码应用补丁和 72 个排序场景、前端类型检查和生产构建、补丁遇到不兼容修改时停止。
首次 GitHub Actions Windows 构建成功，安装包签名、SHA-256、便携版 ZIP 完整性与 x64 架构验证通过。实际程序中已检查个人更新地址及生产验证公钥，更新地址返回的清单与发布文件一致。
未在用户的 Windows 11 上进行安装及跨版本实机升级；安装后应在设置中启用“后台自动更新”，下次新版本发布时完成一次真实升级验收。

## 本地源码与编译

需要两个仓库：本仓库保存可重复应用的补丁和构建脚本，`jlcodes99/cockpit-tools` 保存完整程序（含 Go sidecar 和内置第三方源码）。Zed 官方仓库仅用于核对 Hosted AI 协议，不需要编译 Zed。

当前本地构建固定官方 `v1.3.64`，提交 `4434c32e7bb02f33246941eb5179b0252a93481a`。在 PowerShell 运行：

```powershell
.\Build-Local.ps1
```

默认程序仓库位于与本仓库同级的 `cockpit-tools`；缺少时自动克隆。已有修改不会被重置或覆盖。需要 Node.js、Rust、Go 1.26、Visual Studio C++ Build Tools 和 Windows SDK。脚本先验证补丁及探针，再编译未签名的 EXE 和 NSIS 本地安装包；不生成或替换生产更新签名密钥，不发布 Release。

仅验证错误分类和界面：

```powershell
node scripts/zed-student-availability.test.cjs ../cockpit-tools
cargo test --manifest-path scripts/probe-harness/Cargo.toml
```

`probe-harness` 直接引用实际探针模板。它可用账号导出文件进行一次身份校验和极小请求，并只保存账号 ID、HTTP 状态、可用性和原因；不要把账号导出或 token 提交到仓库。实际测试需明确指定预期的 `user_id`：

```powershell
cargo run --manifest-path scripts/probe-harness/Cargo.toml -- PATH_TO_ACCOUNT_EXPORT EXPECTED_USER_ID PATH_TO_REPORT
```

2026-10-02 本地验证：给定的学生额度耗尽账号身份匹配（HTTP 200），探针得到 HTTP 403 并识别为 `available=false, reason=quota_exhausted`。8 项 Rust 回归测试、旧缓存界面检查及 72 个排序场景通过。凭据未写入仓库或报告。

## 来源与许可

原项目作者：jlcodes99 / jlcodes。
原项目：<https://github.com/jlcodes99/cockpit-tools>。
应用派生修改按原项目 CC BY-NC-SA 4.0 提供；原代码及其第三方许可保持原样。
本仓库修改 Zed 排序、个人更新渠道和 Student Hosted AI 可用性检查；不推算学生计划的美元余额，也不绕过 Zed 的权限或额度限制。

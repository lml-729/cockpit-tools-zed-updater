# Student Hosted AI 修复验收（2026-10-02）

修复已经在 [v1.3.65](https://github.com/lml-729/cockpit-tools-zed-updater/releases/tag/v1.3.65) 正式发布。[完整资产验证记录](verification-v1.3.65.json)。

## 官方协议依据与修复

核对 Zed 官方固定提交 `95cd535a5fad96d649513f96c5784ceefd379e47`：

- [`cloud_llm_client.rs`](https://github.com/zed-industries/zed/blob/95cd535a5fad96d649513f96c5784ceefd379e47/crates/cloud_llm_client/src/cloud_llm_client.rs) 定义 `CompletionEvent` 和 `CompletionRequestStatus`，流包含 `status.failed`、`event` 和 `stream_ended`。
- [`language_models_cloud.rs`](https://github.com/zed-industries/zed/blob/95cd535a5fad96d649513f96c5784ceefd379e47/crates/language_models_cloud/src/language_models_cloud.rs) 的 `perform_llm_request`、`response_lines`、`map_cloud_completion_events` 持续读取 HTTP 200 之后的逐行 JSON，并处理流中失败和不完整结束。
- [`language_model_core.rs`](https://github.com/zed-industries/zed/blob/95cd535a5fad96d649513f96c5784ceefd379e47/crates/language_model_core/src/language_model_core.rs) 将 `permission_error` 等映射为权限错误，保留服务器代码和消息。公开客户端没有 Student 余额查询或学生额度耗尽专用分支。

探针遵循同一协议：获取短期 AI token、查询可用模型、执行最多 1 个输出 token 的极小 Anthropic 请求，完整读取响应后分类。HTTP 200、成功获取 token、模型列表或旧 `model_requests.limit=0` 均不单独作为额度可用/耗尽证据。

明确 `token_spend_limit_reached` 或 `Student plan credits consumed` 才显示“Student 额度已用完”；普通权限错误显示“权限不足”。网络异常、HTML、截断和限流不会显示“可用”。旧探针缓存及导入快照需要刷新后重新检测。

## 本地与远程验证

- 本地官方 `v1.3.64` / `4434c32e7bb02f33246941eb5179b0252a93481a` 完整 Windows release 编译及 NSIS 打包成功。
- 用户提供的已耗尽 Student 测试账号：身份接口 HTTP 200 且身份匹配；同一 Rust 探针得到 HTTP 403，正确返回 `available=false, reason=quota_exhausted`。凭据和账号身份未提交。
- 8 项 Rust 回归测试、旧缓存界面逻辑、重复应用失败保护、72 个排序场景、前端生产构建通过。
- 自动任务检测到新官方 `v1.3.65` / `0b6514b40880efdfd7752ebd5113c6811bafe721`。Git 文件摘要比对确认所有 Zed 补丁目标与本地 v1.3.64 完全相同；随后 v1.3.65 的远程测试、签名编译及发布全部成功。
- 发布配置提交：`303b01c43611c4546f373399d719def874351fbd`；[成功工作流](https://github.com/lml-729/cockpit-tools-zed-updater/actions/runs/36905082505)。
- 便携包补齐原脚本遗漏的根目录资源；实际 20 项 ZIP 条目逐项 CRC 验证通过，含两个 EXE、认证 helper 和 16 个菜单图标。

## 正式更新包验证

| 产物 | 字节数 | SHA-256 |
|---|---:|---|
| `Cockpit.Tools_1.3.65_x64-setup.exe` | 37755510 | `f92247d7168616019d9158500c563edda8303f707c87d6a832ddb694c74cb74e` |
| `Cockpit.Tools_1.3.65_x64-portable.zip` | 53504870 | `879fe47c28b5f7ee8fa05bd0f1b5b99918f94d18a6f5e9f2780ac5dc22936b78` |

全部 SHA256SUMS 条目匹配；安装包 PE 版本为 1.3.65；Minisign 使用实际生产更新公钥验签成功。这里的签名是客户端更新签名，不等同于 Windows Authenticode 代码签名。

`latest.json` 中 `windows-x86_64` 和 `windows-x86_64-nsis` 均指向本次安装包，签名与 `.sig` 文件一致。实际公开地址 `https://github.com/lml-729/cockpit-tools-zed-updater/releases/latest/download/latest.json` 已读取并确认为 1.3.65。

Tauri 本地 bundler 的包类型变量警告已核对：实际 `tauri-plugin-updater 2.10.1` 支持通用 `windows-x86_64` 清单键，并从 EXE 文件头识别 NSIS；本更新渠道不依赖缺失的包类型标记。

## 自动更新与边界

GitHub Actions 总开关和定时发布工作流已启用；每小时第 23 分钟检查官方正式版。客户端已开启自动检查及后台自动安装，检查间隔 1 小时。发布前已同步原生版本，并使中间测试失败能立即阻止发布。

尚未做安装后的图形界面或真实跨版本升级验收；标准 Windows 图形界面控制工具的 native pipe 在本次环境不可用。已完成的验证是实际账号探测、界面逻辑回归、编译和生产更新资产验收。

按用户要求，本次本地源码、依赖构建目录、测试账号导出和下载产物在完成验收与记录提交后统一清理，代码、验证记录和发布包保留于 GitHub。

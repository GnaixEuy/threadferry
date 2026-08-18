# Contributing to Warden

## Commit message

所有新提交使用以下格式：

```text
<gitmoji> <type>(<scope>): <清晰描述>
```

`scope` 可省略。描述使用中文，直接说明完成了什么。不要使用“更新代码”“修复问题”
或“一些调整”等模糊表述。结尾不加句号，整行不超过 72 个字符。

常用类型与 Gitmoji：

| Gitmoji | type | 用途 |
| --- | --- | --- |
| ✨ | `feat` | 新功能 |
| 🐛 | `fix` | 缺陷修复 |
| 🔒 | `security` | 安全修复或权限收紧 |
| ♻️ | `refactor` | 不改变行为的重构 |
| ✅ | `test` | 测试新增或调整 |
| 📝 | `docs` | 文档变更 |
| ⚡️ | `perf` | 性能优化 |
| ⬆️ | `deps` | 依赖升级 |
| 🔧 | `chore` | 构建、配置或维护工作 |
| 💥 | 与实际类型组合 | 不兼容变更，并在 type 后添加 `!` |

示例：

```text
✨ feat(auth): 支持创建者按姓名授权群用户
🐛 fix(wecom): 修复通讯录身份与回调身份映射
🔒 security(runtime): 禁止 Codex 访问 Workspace 外文件
✅ test(auth): 覆盖同名成员拒绝自动授权
📝 docs: 补充企业微信真实联调步骤
💥 feat(config)!: 移除旧版配置格式
```

其他要求：

- 一个提交只处理一个目的；功能、重构和无关格式化不要混在一起。
- 提交前运行与变更相关的检查。代码变更至少运行 `npm run typecheck` 和 `npm test`。
- 需要解释原因、风险或迁移方式时写 commit body；标题仍只写结果。
- 不提交 `warden.yaml`、Secret、Token、`.env`、本地状态、日志、`dist`
  或 `node_modules`。
- 不兼容变更必须使用 `!`，并在 commit body 中说明迁移方式。

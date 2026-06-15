---
name: x-followback-audit
description: X/Twitter following-list-only follow-back audit. Use when Codex needs to log in with the user's X account, read only the logged-in account's Following/正在关注 list, identify followed accounts that do not show the gray "关注了你" / "follows you" badge, and export a desktop Excel file containing only username, follow-back status, and blue-V status. No search, no follower-list scraping, no opening followed users' profiles, no account changes, no unfollow.
---

# X Follow-Back Audit

## 唯一职责

登录用户自己的 X 账号，只读取该账号的 `正在关注 / following` 列表，从列表行里筛选没有回关的人，并导出桌面 Excel。

## 安全边界

- 只访问当前登录用户的个人资料页和 `/following` 列表页。
- 个人资料页只用于读取 `正在关注 / following` 总数，校验列表是否读完整。
- 不读取 `followers / 关注者` 列表。
- 不搜索其他来源。
- 不打开被关注用户主页。
- 不点击右侧 `正在关注 / Following` 按钮。
- 不关注、取关、点赞、评论、私信或修改账号信息。
- 不推断数据；只使用当前屏幕行内可见信息。

## 判断规则

- `UserCell` 行中的账号就是当前登录用户正在关注的人。
- 行内灰色 `关注了你` / `follows you` 标识代表已回关。
- 行内没有灰色回关标识，代表未回关。
- 行内蓝色对勾代表蓝 V / verified，只记录为 `是否蓝V标识`，不影响回关判断。

## 滚动规则

- 进入当前登录账号的 `/following` 页面后，用滚轮向下读取。
- 用个人资料页的 `正在关注 / following` 总数作为期望数量和校验值，但不要把它当成无限循环的硬目标。
- 如果读到期望数量，正常结束。
- 如果页面看似到底但还没读到期望数量，执行有限次数底部补拉：轻微上滑，再连续下滑，促使 X 虚拟列表继续加载。
- 如果页面到底、滚动位置稳定、连续多次没有新增账号，就认为 X 当前列表已经实际到底，停止并导出已读取结果。
- 如果补拉次数耗尽仍未新增，也必须停止，并在日志中记录期望数量、实际读取数量和差额。
- 不允许无限空转。

## 输出字段

Excel 只能包含三列：

- `用户名`
- `是否回关`
- `是否蓝V标识`

导出内容只包含未回关账号。

## 命令

```powershell
node .\x-followback-audit\scripts\collect_followback_audit.mjs --login --max-scrolls 500 --scroll-pause-ms 900 --bottom-retries 30 --out .\x_followback_audit.json
```

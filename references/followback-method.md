# X Follow-Back Audit Method

## Collection Standard

Collect only from the logged-in user's own `Following / 正在关注` list:

- `handle`
- `relationship`
- `blue_verified`

Export only rows where `relationship` is `not_following_back`.

## Count Standard

1. Open the logged-in user's own profile page.
2. Read only the `following / 正在关注` count.
3. Use that count as the expected number of unique handles to collect from `/following`, not as an infinite-loop hard target.
4. Enter the logged-in user's `/following` page.
5. Stop normally when collected unique handles reach the profile `following` count.

If X reaches the apparent page bottom before the target count:

- Do not stop immediately.
- Nudge up, then wheel down several times to trigger lazy loading.
- Reset retry count whenever new handles appear.
- If the page is at bottom, scroll position is stable, and no new handles appear for several attempts, treat the visible X list as practically exhausted.
- Stop after stable bottom detection or the configured retry limit, then log expected count, actual count, and gap.

## Relationship Logic

Normalize handles like `@user`.

1. Inspect visible `UserCell` rows in the following list.
2. If the row contains the gray `关注了你`, `follows you`, or equivalent badge, mark `mutual`.
3. If the badge is absent on a visible row, mark `not_following_back`.
4. Do not infer follow-back status from any other source.

## Blue-V Logic

- Mark `blue_verified: true` only when a blue check / verified badge is directly visible in the same `UserCell` row.
- Mark `blue_verified: false` when no such badge is visible in that row.

## Export Standard

Excel must contain only:

- `用户名`
- `是否回关`
- `是否蓝V标识`

The workbook must contain only not-following-back accounts.

## Strict Prohibitions

- No search.
- No follower-list scraping.
- No opening followed users' profiles.
- No clicking follow/following buttons.
- No unfollowing.
- No likes, comments, DMs, or profile edits.

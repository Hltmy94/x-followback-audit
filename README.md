# X Follow-Back Audit

推特用户正在关注列表回关审查库。

## What It Does

This repo packages a Codex skill for auditing a logged-in X account's `Following / 正在关注` list, identifying accounts that do not follow back, and exporting a desktop Excel file with only:

- 用户名
- 是否回关
- 是否蓝V标识

## Highlights

- Only reads the logged-in user's own following list
- Uses visible row-level badges for follow-back detection
- Handles large lists with scroll-based lazy loading
- Exports a clean desktop workbook for review

## Safety Boundary

- No search
- No follower-list scraping
- No opening followed users' profiles
- No account changes
- No unfollowing

## Repo Contents

- `SKILL.md`: skill instructions
- `scripts/collect_followback_audit.mjs`: browser collection workflow
- `scripts/export_followback_audit.py`: Excel export
- `references/followback-method.md`: collection rules

## Usage

Run the collection script in an authenticated browser session, then export the collected rows to desktop Excel.


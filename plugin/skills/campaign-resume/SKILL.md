---
name: campaign-resume
description: Compatibility note for old prompts that mention campaign resume.
---

# Retired resume instruction

There is no implicit resume operation. A fresh Codex session starts unbound. Use `campaign-discovery`: call `campaign_list` or `campaign_search`, inspect with `campaign_detail`, then bind the owner-selected record with `campaign_bind`.

`campaign_open` and `campaign_resume` are retired. Direct calls return `DEPRECATED_TOOL` with `mutated: false`. Do not create a phase-specific campaign ID or reuse an ID with a changed identity.

---
name: campaign-finish
description: Finish or intentionally abandon a bound research campaign after evidence and reconciliation review.
---

# Campaign finish and abandon

Do not finish from a chat summary. Call `campaign_status` with `view: "full"` and confirm that the bound campaign is at its verifying or closing gate. Review:

- every parent and child work package;
- accepted, rejected, requested-change, and blocked outcomes;
- changed files and protected files left untouched;
- source, method, test, review, and consumer evidence;
- unresolved risks and owner decisions;
- backup and restore locations; and
- the current campaign version and lifecycle.

Use `campaign_finish` only with a bound session and closeout evidence that satisfies the requested closure kind. Use `campaign_abandon` when the owner intentionally terminates the campaign; include the reason and limitations. Neither operation deletes the SQLite journal or snapshots.

If evidence is missing, keep the campaign open or move it to the permitted waiting or blocked state. Call `campaign_unbind` after the terminal response when the session should return to discovery mode.

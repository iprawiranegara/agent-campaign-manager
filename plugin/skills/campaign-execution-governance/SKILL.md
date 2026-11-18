---
name: campaign-execution-governance
description: Apply Superpowers execution, review, and verification discipline to campaign work packages.
---

# Campaign execution governance

Use this skill for code, data pipelines, migrations, computations, tests, and other repository changes. For `engineering` and `research_delivery`, the campaign requires Superpowers execution work.

Before editing:

1. Read the target repository instructions and README cascade.
2. Register a bounded `campaign_work_package` with exact allowed paths.
3. State forbidden actions, required checks, and stop conditions.
4. Record the pre-change state and backup boundary required by the repository.

After work:

1. Record file, command, test, and review receipts.
2. Review the diff and test output in the parent thread.
3. Reconcile the child package only after the parent has checked the evidence.

Do not claim a consumer-facing change from configuration or unit tests alone. Stop when live consumer proof is required but not authorized or not passing.

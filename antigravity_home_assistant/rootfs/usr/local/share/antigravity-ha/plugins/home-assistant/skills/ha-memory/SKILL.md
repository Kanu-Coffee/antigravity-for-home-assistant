---
name: ha-memory
description: Retrieve and maintain bounded, validated semantic memory for Home Assistant subjects. Use at the beginning of Home Assistant work and for durable user-stated facts or verified persistent changes.
---

# Validated Home Assistant memory

Use `memory_search` with only the current question, named subjects, and a small
limit. Never read or dump `/data/antigravity-ha-memory/memory.sqlite3` directly.
Distinguish empty, degraded, and stale memory from a verified no-result.

Store only durable, non-secret facts explicitly stated for an exact subject via
`memory_remember_explicit`. Other learning follows candidate, evidence,
verification, and apply. Never store current states, timestamps, raw prompts,
credentials, or raw automation logic. Persistent Home Assistant changes use
`memory_begin_change` before the mutation and `memory_verify_change` only after
fresh API verification.

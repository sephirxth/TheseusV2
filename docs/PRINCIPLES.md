# First Principle: Find the Mature Solution Before Building Your Own

> 2026-08-09, the owner: "TheseusV2 should use classic, reliable, robust methods wherever they exist. When a problem appears, first ask whether the essence of this problem class already has a mature solution. **This system should contain only the parts that genuinely have no existing answer.**"

**Practice**: when facing a problem, ask first — **has humanity already solved the essence of this problem class?**
If yes, use it, and name the source in the design document.
If no, build it yourself; and **mark every self-built piece explicitly**, because those are the most expensive, most error-prone parts of the system.

## It Has Already Won Four Times

This is not a new rule — it is the pattern where **every time it was followed the project won, every time it was ignored the project bled.**

| Problem | First instinct (build own) | Replaced by whose mature solution | Result |
|---|---|---|---|
| Process lifecycle | a 564-line hand-rolled watchdog | **systemd** (four decades of init evolution) | 500 lines deleted |
| Concurrent commands | in-memory version guard | **file locks** (dpkg / apt / git all do this: `O_EXCL` + lockfile) | works across processes |
| Who deletes leftover artifacts | delete by name prefix (`theseus-*`) | **declared-state reconciliation** (Terraform / Kubernetes / Puppet consensus) | no orphans, no missed |
| What stores traces | a custom file format | **SQLite** | atomic (transactions), single-recorded (unique constraints), causal chains (recursive queries), queryable (indexes) |

**A harder observation**: what the mature solutions gave was not merely "saved work" —
they made **entire categories of requirements disappear**. The hard problems a hand-rolled
solution must solve are often problems **the hand-rolled solution itself created**.

## Conversely: What Genuinely Needs Building

Folding state from append-only traces, the human door (HumanDoor), intent canonization —
these have no off-the-shelf answer. That is exactly why they are the system's core.

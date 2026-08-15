# --allowedTools pre-approves; it does not restrict

**Trap.** A "read-only" planning run launched claude -p with
`--allowedTools Read,Grep,Glob` and was assumed unable to edit. Wrong:
allowedTools only pre-APPROVES tools (no permission prompts). Machine
settings that permit write-capable tools (broad Bash allowances) still
apply - the planning agent could have edited files. Caught by read-only
verification, not by tests (stubs assert argv, not semantics).

**Rule.** Restriction requires `--disallowedTools` - a hard deny that
wins over any allow. Any Atelier feature claiming an agent "cannot do X"
must be enforced with a deny, and the claim tested against the flag that
actually enforces it.

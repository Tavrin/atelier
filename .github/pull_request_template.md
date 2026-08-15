## What this changes

<!-- What behaviour is different after this PR, and why. -->

## Verification

<!-- Paste the result. "Tests pass" without output is not evidence. -->

- [ ] `node --test` from the repository root is green
- [ ] For changes to request handling, subprocess execution, or dispatch
      surfaces: the injection probe in `docs/SECURITY.md` was run

```
paste test output here
```

## Rules check

- [ ] Adds **no** runtime dependency to core (`node:*` stdlib is fine; a
      vendored, frozen, single-file library inside a `themes/<id>/` bundle is
      fine; anything else is not)
- [ ] Does not weaken the security core — the content-type gate, 256 KB body
      cap, leading-dash rejection, or argv-array subprocess execution
- [ ] Does not add authentication assumptions or non-loopback binding
- [ ] New UI work routes colour through the semantic token tier and has a
      styleguide entry (see `docs/DESIGN.md`)

## Platform

<!-- Which OS you tested on. Windows results are especially welcome; see docs/WINDOWS.md -->

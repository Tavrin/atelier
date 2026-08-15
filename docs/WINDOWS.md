# Windows smoke checklist

Atelier is written to be Windows-portable — `node:path` everywhere, no symlinks,
and explicit POSIX/win32 branches for process-group kill and user-directory
resolution — but it has **not been verified end to end on Windows**. This page
is the checklist for anyone who wants to close that gap.

Working through it and reporting the results is one of the most useful
contributions available right now.

## Checklist

- [ ] Clone the repository and enter its directory.
- [ ] Run `node bin\atelier.mjs init`.
- [ ] Run `node bin\atelier.mjs serve` and open the printed loopback URL.
- [ ] Add one project through the UI.
- [ ] Complete one isolated dispatch.
- [ ] Verify and merge that dispatch through Atelier.
- [ ] Run `node bin\atelier.mjs doctor --install-service --dry-run`. It must
      print the `schtasks` argv for an `ONLOGON` task **without registering
      it** — if it registers anything during a dry run, that is a bug worth
      reporting on its own.

## Reporting

Open an issue with:

- The command you ran and its full output
- Your Windows version and Node.js version (`node --version`)
- Whether you used PowerShell or Command Prompt
- Whether the failure was reproducible on a second run

Path handling, process termination, and the service-install path are the three
areas most likely to break. Failures there are expected rather than
embarrassing — that is why this checklist exists.

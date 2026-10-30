# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion for a security problem.

Include what you found, how to reproduce it and what an attacker could do with it. You will get an answer as soon as the maintainer can review it; a fix is published before the details are made public.

## What counts as a vulnerability

ANOMANDER serves one principal per installation and holds personal data, so these matter most:

- Anyone other than the principal getting a reply, or causing a row to be written (PRD R-1).
- The processor (the model) writing to the database, gaining a tool, or having its output stored with a mode other than `inferred` (PRD R-14).
- Any way to move money, grant a permission or act towards third parties: those operations must not exist (PRD §8.1).
- Secrets or personal data reaching the repository, logs or a model provider beyond what PRD §16 allows.
- Receipt images surviving longer than PRD R-8 allows.

## Supported versions

Only the latest commit on `main` is supported.

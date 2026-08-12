# Security Policy

## Supported version

Only the latest public preview is supported. This project is beta software and must not be treated as an unattended publisher.

## Reporting a vulnerability

Use GitHub Private Vulnerability Reporting for this repository. Do not open a public issue containing:

- bearer tokens or token hashes;
- browser Profile data, cookies or account screenshots;
- audit logs from a real account;
- private platform URLs carrying session context;
- local filesystem paths that identify private material.

Include the affected version, a minimal reproduction using a temporary Profile or local fixture, expected behavior and actual behavior. Do not test destructive, publishing, payment or account-management actions against accounts you do not own.

## Security model

The public beta is designed around a contribution-only boundary. Login, verification, legal consent, creation, final submission, publishing, deletion, payment and credit-consuming actions remain human-only. A finding that bypasses this boundary should be treated as high severity.

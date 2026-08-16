# Security Policy

`cerase-acp` is the chat-to-ACP DM bridge of the Cerase platform: it connects
Discord, Telegram, Slack and Google Workspace Chat to an agent runtime over the
Agent Client Protocol. It holds bot tokens and it handles user messages and
attachments, so a defect here can expose conversation content or the
credentials of a connected workspace.

It is maintained by Guidance Studio S.r.l.

## Supported versions

The release unit is the container image built from `main` and published to
`ghcr.io/cerase-ai/cerase-acp` as `latest`, `main` and `sha-<short>`.

| Version | Gets security fixes |
|---|---|
| the image built from `main` | yes |
| the `v0.2.0-beta` and `v0.3.0-dev` git tags | no |

A fix ships as a new image built from `main`. No earlier line is patched, and
there is no long-term-support branch.

## Reporting a vulnerability

Email **tech@guidance.studio** with `cerase-acp` in the subject. That mailbox
reaches the maintainers.

Do not open an issue, a discussion or a pull request for a suspected
vulnerability. This repository is public, so any of those is a disclosure.

Include as much of this as you have:

- what the defect is, and which file, endpoint or chat adapter it is in
- the image tag or commit you tested
- steps to reproduce, or a proof of concept
- what an attacker gains, and what access they need to begin

Reports in English or Italian are equally welcome.

## What happens after you report

We confirm the report arrived, tell you whether we reproduced it and how we
rate it, and tell you which image carries the fix once that image is published.

We do not publish a response-time commitment. Cerase is a small team and a
number here that we missed would be worse than no number: treat silence as a
mail that did not arrive rather than as a decision, and send it again.

## Disclosure

Please hold details until a fixed image is on GHCR. We will tell you when that
happens, and we will credit you unless you prefer otherwise.

There is no paid bug bounty.

## Other Cerase components

This repository is the DM bridge alone. The control plane, the policy gateway,
the marketplace and the provisioning tooling live in separate repositories and
have no separate reporting channel: send those findings to the same address and
name the component.

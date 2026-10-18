# Contributing to cerase-acp

`cerase-acp` is maintained by Guidance Studio S.r.l. as part of the Cerase
platform. Bug reports and pull requests are welcome. Report a suspected
vulnerability privately, as [`SECURITY.md`](SECURITY.md) describes, never in an
issue or a pull request.

## Before you open a pull request

- Run what CI runs on the code: `npm ci`, `npm run lint`, `npm run build` and
  `npm test`. The suite needs no Docker, chat platform or network.
- Add or change a test beside the code you change, as `src/**/*.test.ts`.
- Leave the files pinned by `scripts/TOOLING.sha256` alone. They are copies of
  another Cerase repository's, and CI fails when one differs.
- A comment says what the code does and why. When and under which ticket it
  changed belongs in the commit message, and `scripts/comment-check.sh` refuses
  it in a comment.

## How a change lands

The maintainers commit to `main`. A pull request runs `.github/workflows/ci.yml`
and is merged by a maintainer once its checks pass. A push to `main` runs the
same checks again and publishes the image, as the Release section of
[`README.md`](README.md) describes.

## Licence

A contribution is licensed under the MIT licence in [`LICENSE`](LICENSE), the
licence of the rest of the repository.

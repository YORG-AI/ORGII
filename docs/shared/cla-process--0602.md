---
title: CLA Signing Process
status: active
last_updated: 2026-06-02
---

# CLA Signing Process

This document describes how ORGII maintainers operate the repository Contributor License Agreement process. Contributor-facing instructions live in `.github/CONTRIBUTING.md`, and the agreement text lives in `docs/contributing/CLA.md`.

## Enforcement model

ORGII uses GitHub CLA Assistant as the pull request enforcement mechanism.

The repository stores the canonical CLA text in `docs/contributing/CLA.md`. CLA Assistant should be linked to a GitHub Gist that contains the approved agreement text used for signatures. Keep the Gist content aligned with `docs/contributing/CLA.md` whenever the agreement changes.

## Initial setup

A GitHub organization or repository admin must complete these steps:

1. Review and approve the legal text in `docs/contributing/CLA.md`.
2. Create a GitHub Gist containing the approved CLA text.
3. Install or enable the CLA Assistant GitHub App for the ORGII repository or owning organization.
4. Link the ORGII repository to the CLA Gist in CLA Assistant.
5. Configure excluded accounts for automation and maintainer bot users when appropriate.
6. Open a test pull request from an unsigned account to confirm that CLA Assistant comments and reports a failing status check.
7. Complete the signature flow and confirm that the check passes.
8. Add the CLA Assistant status check to required checks for protected branches, including `main` and `develop`.

## Individual contributors

Individual contributors may sign when they are contributing their own work and are legally allowed to submit it. Once CLA Assistant records the signature, future pull requests from the same GitHub account should pass automatically unless the CLA text changes or signatures are reset.

## Corporate contributors

Corporate contributors may sign on behalf of an employer or organization only when they are authorized to bind that entity to the CLA.

Maintainers should review corporate signatures when:

- The signer uses a personal email address for a company contribution.
- The signer claims authority for a company or organization that is not clearly associated with the GitHub account.
- The contribution appears to include employer-owned work but the signer selected the individual path.
- A company asks to manage or revoke contributor authority.

If authority is unclear, ask the contributor to provide confirmation before merging. Do not merge until the CLA status check passes and maintainer review is satisfied.

## CLA updates

When the CLA text changes materially:

1. Update `docs/contributing/CLA.md` in the repository.
2. Update the CLA Assistant Gist to match the approved text.
3. Decide whether existing contributors must re-sign.
4. If re-signing is required, reset or invalidate signatures through the CLA Assistant administration flow.
5. Announce the change in `.github/CONTRIBUTING.md` or the relevant release/contributor communication channel.

## Bot and automation accounts

Automation accounts may be excluded from CLA checks if they only submit generated maintenance changes controlled by maintainers. Do not exclude human contributor accounts to bypass the CLA process.

## Troubleshooting

If a contributor says the CLA check is stuck:

1. Confirm that the PR author is the GitHub account that signed the CLA.
2. Ask the contributor to re-open the CLA Assistant signing link from the PR comment.
3. Check whether the contributor signed as an individual when corporate authorization is required.
4. Confirm that the CLA Assistant app still has access to the repository.
5. Re-run or refresh the CLA check from the PR if GitHub status reporting is stale.

If CLA Assistant is unavailable, block merges for unsigned external contributors until the service is restored or maintainers complete an equivalent documented signature review.

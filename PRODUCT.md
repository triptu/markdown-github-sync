# Product
<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
The repository owner, evaluating a proposal for self-contained Obsidian sync between laptops and phone.

## Product Purpose
This design surface explains the proposed GitHub-authoritative sync architecture, alternatives, conflict resolution, evidence, and migration gates. It is a standalone browser document, not a shipping sync interface.

## Operating Context
The user rejected the previous stretched, T3-inline-oriented artifact and requested a visually strong rebuild from scratch. The existing standalone HTML and detailed Markdown proposal provide the factual content. Desktop browser presentation takes priority; mobile must remain readable.

## Capabilities and Constraints
Only committed GitHub versions are shared authority. Drafts remain local. The proposed plugin replaces Obsidian Git after verification. No server is recommended. The real vault is untouched. Live isolated GitHub experiments passed, while mobile reliability and local crash safety remain unverified. Interactive examples must be clearly synthetic.

## Evidence on Hand
Detailed truth: docs/github-sync-proposal.md. Design review: docs/github-sync-review.md. Tests: research/github-api-experiments/. User rejection screenshot in thread. No brand assets or phone model established.

## Product Principles
Explain the mechanism through diagrams and concrete states. Distinguish proposal from working implementation. Preserve factual content. Design for a normal browser with deliberate spacing and bounded reading width.

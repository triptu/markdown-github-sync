---
name: GitHub Sync Proposal
description: Standalone browser document explaining the proposed GitHub-authoritative Obsidian sync.
colors:
  paper: "#f5f3eb"
  white: "#fffef9"
  ink: "#213f35"
  body: "#35483e"
  muted: "#55614e"
  line: "#d6d9ca"
  green: "#254f40"
  green-hover: "#183c2d"
  green-light: "#e5ebdf"
  evidence-green: "#24483a"
  amber: "#8e4a25"
  amber-light: "#f4e1c9"
  focus-amber: "#a36535"
typography:
  display:
    fontFamily: "Newsreader, Georgia, serif"
    fontSize: "clamp(64px, 6.4vw, 86px)"
    fontWeight: 500
    lineHeight: 0.98
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Newsreader, Georgia, serif"
    fontSize: "clamp(38px, 4.1vw, 54px)"
    fontWeight: 500
    lineHeight: 1.04
    letterSpacing: "-0.025em"
  title:
    fontFamily: "DM, sans-serif"
    fontSize: "20px"
    fontWeight: 500
    lineHeight: 1.3
  lead:
    fontFamily: "DM, sans-serif"
    fontSize: "21px"
    fontWeight: 400
    lineHeight: 1.55
  body:
    fontFamily: "DM, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "DM, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "0.09em"
  code:
    fontFamily: "ui-monospace, monospace"
    fontSize: "0.82em"
rounded:
  note: "4px"
  control: "5px"
  button: "6px"
  panel: "12px"
  hero-map: "18px"
  pill: "50%"
spacing:
  page-gutter: "56px"
  container: "1240px"
  section: "104px"
  section-intro-gap: "80px"
  hero-gap: "70px"
components:
  button-primary:
    backgroundColor: "{colors.green}"
    textColor: "{colors.white}"
    rounded: "{rounded.button}"
    padding: "13px 22px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "{colors.green-hover}"
  segmented-control:
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  segmented-control-active:
    backgroundColor: "{colors.green}"
    textColor: "{colors.white}"
  choice-button:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  choice-button-active:
    backgroundColor: "{colors.green}"
    textColor: "{colors.white}"
  badge-demo:
    backgroundColor: "{colors.amber-light}"
    textColor: "{colors.amber}"
    rounded: "{rounded.note}"
    padding: "3px 9px"
  hero-map:
    backgroundColor: "{colors.green-light}"
    rounded: "{rounded.hero-map}"
    padding: "28px 28px 22px"
  resolver-panel:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.panel}"
---

# Design System: GitHub Sync Proposal

Scope: the standalone `docs/github-sync-proposal.html` page and `docs/assets/proposal.css` only. This is not the Obsidian plugin UI and not a user-approved brand. Tokens are extracted from the implemented CSS; responsive corrections were verified at 390, 768, and 1440px.

## Overview

**Creative North Star: "The Field Report"**

The page is a printed technical brief on warm paper: a serif editorial voice for headings, a quiet sans for explanation, and deep forest green for anything that represents committed, authoritative state. Amber marks what is local, unresolved, or synthetic. Density is moderate: generous section rhythm (104px) with compact 11–13px labels inside diagrams.

Depth comes from tonal panels and hairline rules rather than shadows. Explanations are built from diagrams and concrete states (device-to-repo map, four-phase transaction strip, conflict resolver demo), not decorative imagery.

**Key Characteristics:**
- Warm off-white paper ground with green-ink text; light scheme only.
- Newsreader serif headlines, DM Sans for everything else.
- Green = committed/authoritative; amber = draft, conflict, or demo.
- Hairline `line` rules divide content; tonal green panels group it.
- Bounded 1240px container; reading paragraphs capped around 420–510px.

## Colors

A restrained two-hue palette — forest green and burnt amber — on warm paper.

### Primary
- **Forest Green** (`green`): primary buttons, active segmented/choice controls, the commit-history card in the hero map. Represents GitHub-committed authority.
- **Forest Green Hover** (`green-hover`): primary button hover only.
- **Evidence Green** (`evidence-green`): the single dark full-bleed band (evidence section), with light text `#f5f4e9` and secondary `#d4ddcb`.

### Secondary
- **Burnt Amber** (`amber`): draft labels, demo badge text, local/unpublished state.
- **Amber Wash** (`amber-light`): `mark` highlights, demo badge fill. Diff local-change fill is the close `#f4dfc4`; remote-change fill is `#dce9cf`.
- **Focus Amber** (`focus-amber`): 3px focus outline, 5px offset.

### Neutral
- **Paper** (`paper`): page background.
- **Warm White** (`white`): note sheets, resolver panel, textarea, button text on green.
- **Green Ink** (`ink`): headings and default text.
- **Body** (`body`): option-row paragraph text.
- **Muted Olive** (`muted`): secondary text, labels, captions.
- **Hairline** (`line`): rules, dividers, pane borders.
- **Green Wash** (`green-light`): hero map panel; related tints `#e8ece2` (conflict section band), `#e6ebdd` (chosen option row), `#e9eddf` (authority phase).

**The Authority Color Rule.** Solid green fill means "this is the committed/shared version or the selected action." Don't use it for decoration.

**The Synthetic Is Amber Rule.** Demo, draft, and conflict states are labelled in amber so illustrative content is never mistaken for real vault data.

## Typography

**Display Font:** Newsreader (Georgia, serif), bundled 400/500 TTF
**Body Font:** DM Sans, declared as family `DM` (sans-serif), bundled 400–700 TTF
**Mono:** `ui-monospace, monospace` at 0.82em

**Character:** Literary serif headlines over a neutral geometric sans; the serif also appears inside diagram "notes" to suggest actual Markdown note text.

### Hierarchy
- **Display** (hero h1): balanced wrap; `em` inside renders upright at 400 in `#557446`. 92px at ≥1600px.
- **Headline** (section h2): balanced wrap. Closing h2 fixed at 48px; rollout h3 uses the serif at 30px.
- **Title** (h3): 20px default; component titles step down to 18–19px.
- **Lead**: hero intro, max 420px.
- **Body**: 16px / 1.6; section-intro paragraphs max 510px; supporting text 13–15px.
- **Label**: 11–12px for diagram labels, captions, badges; phase steps use 0.09em tracking, draft labels uppercase at 0.06em.

**The Two Voices Rule.** Serif is for headings and for depicted note content; never for UI controls or labels.

## Layout

- Container `.wrap`: `min(1240px, 100% - 112px)`; gutters shrink to 72px (≤1100px), 44px (≤800px), 40px (≤600px).
- Hero: two columns 0.85fr / 1.15fr, 70px gap, copy left and diagram right.
- Section intro: 1fr / 1fr grid, 80px gap, 45px bottom margin. Sections pad 104px vertically (evidence band 88px).
- Transaction: 4 equal phases separated by vertical hairlines. Evidence grid 1.15fr / 0.85fr, 90px gap.
- Breakpoints: 1600px (min, larger hero), 1100px, 800px (masthead nav hidden), 600px. The hero diagram stacks below 800px.
- Print styles hide interactive controls; `prefers-reduced-motion` removes transitions and smooth scrolling.

## Elevation & Depth

Flat and tonal. The only shadow is on the depicted note sheets (`0 6px 16px #0000000d`), suggesting paper on a surface. Everything else separates by tint (paper → green wash → forest green) and 1px hairlines.

**The Paper-Only Shadow Rule.** Shadows belong to depicted documents, not to UI panels or buttons.

## Shapes

Soft-but-small corners that grow with container size: 4px note sheets and badges, 5px controls, 6px buttons and diff panes, 10px phone note, 12px resolver and commit card, 18px hero map. The declared `--radius: 14px` variable is currently unused. Circles (50%) for status dots, commit nodes, and rollout step numbers. Borders are 1px hairlines; icons are 1.6px-stroke outline SVGs at 15–26px.

## Components

### Buttons
- **Shape:** gently rounded (6px), min height 48px.
- **Primary:** forest green fill, warm-white text, 14px/500, 20px icon gap.
- **Hover / Focus:** background darkens over 0.18s; amber 3px outline on focus-visible.
- **Disabled:** `#dfe3d9` fill, `#56604f` text, not-allowed cursor.

### Segmented and choice controls
- **Scenario controls:** transparent, muted text, 5px radius; hover `#e6e9df`; `aria-pressed="true"` fills forest green.
- **Choice buttons (resolver):** warm white with `#c9cebd` border; pressed state fills green.

### Cards / Containers
- **Hero map:** green wash panel, 18px radius, contains white note sheets and a solid green commit-history card.
- **Resolver:** warm white, `#bdc8b7` 1px border, 12px radius; file list sidebar `#f2f4ec`; diff panes with `#f5f5ee` header strips.
- **Option rows:** full-width rows split by hairlines; the recommended row gets the `#e6ebdd` tint.

### Inputs / Fields
- **Textarea:** borderless, warm white, 14px, inside a hairline-bordered 6px result pane; amber focus outline.

### Navigation
- **Masthead:** brand (700 weight, 26px icon) left, 14px text links right with 30px gap; hover shifts to amber `#9c522d`; links hidden ≤800px.

### Transaction Strip (signature)
Four phases with small tracked step labels, 19px titles, muted 13px copy, and an underlined state label pinned to the bottom. The GitHub-authority phase gets the `#e9eddf` tint and bold state.

## Do's and Don'ts

### Do:
- **Do** use forest green fill only for committed authority and selected actions.
- **Do** label every synthetic example with amber demo/draft styling.
- **Do** separate content with 1px `line` hairlines and tonal panels.
- **Do** keep reading paragraphs within ~420–510px inside the 1240px container.

### Don't:
- **Don't** treat these tokens as the Obsidian plugin's UI or an approved brand.
- **Don't** add shadows to panels or buttons; the paper-sheet shadow is the only one.
- **Don't** use Newsreader for controls, labels, or captions.

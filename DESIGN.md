---
name: GitHub Sync Proposal
description: Editorial field-guide system for the standalone GitHub-authoritative Obsidian sync proposal and its documentation pages.
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
  badge-decision:
    backgroundColor: "{colors.amber-light}"
    textColor: "{colors.amber}"
    rounded: "{rounded.note}"
    padding: "3px 9px"
  hero-map:
    backgroundColor: "{colors.green-light}"
    rounded: "{rounded.hero-map}"
    padding: "28px 28px 22px"
  commit-history:
    backgroundColor: "{colors.green}"
    textColor: "{colors.white}"
    rounded: "{rounded.panel}"
    padding: "20px 16px"
  resolver-panel:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.panel}"
---

# Design System: GitHub Sync Proposal

**Scope.** Standalone proposal and documentation surfaces only: today `docs/github-sync-proposal.html` with `docs/assets/proposal.css` and `proposal.js`. It does not govern the Obsidian plugin's UI, which should follow Obsidian's own conventions. **Status:** implemented direction, pending user feedback; not an approved brand. Tokens are extracted from the shipped CSS. A later visual review may adjust the mobile hero, so responsive notes below describe intent rather than fixed per-selector layouts.

## Overview

**Creative North Star: "The Editorial Field Guide"**

The page reads as a printed field guide to one mechanism: warm paper, forest-green ink, a literary serif for headings, and a quiet sans for explanation. It is a scroll narrative (hero diagram → four-phase transaction → conflict workspace → alternatives → evidence band → closing) inside a bounded 1240px column, with generous 104px section rhythm and compact 11–13px labels inside diagrams.

Explanation comes from concrete depicted states, not decoration: sample note text ("Meet on Tuesday."), a Git commit history with short hashes, a laptop-to-GitHub-to-phone map, and a central interactive conflict resolver. Every depicted state is synthetic and says so in words. Depth comes from tonal panels and hairline rules; the only shadow belongs to depicted paper.

**Key Characteristics:**
- Warm paper ground, green-ink text; light scheme only.
- Newsreader serif for headings and depicted note text; DM Sans for everything else.
- Solid green = committed GitHub authority or the selected action; amber = local, unresolved, or not yet real.
- Hairline rules divide content; tonal green panels group it.
- Bounded 1240px container; reading paragraphs capped around 420–510px.
- Synthetic examples and the unreleased proposal status are labelled in plain words.

## Colors

A restrained two-hue palette, forest green and burnt amber, on warm paper.

### Primary
- **Forest Green** (`green`): primary buttons, pressed segmented and choice controls, the commit-history card in the hero map. Stands for committed GitHub authority.
- **Forest Green Hover** (`green-hover`): primary button hover only.
- **Evidence Green** (`evidence-green`): the single dark full-width band (evidence and rollout), with light text `#f5f4e9` and secondary `#d4ddcb`.

### Secondary
- **Burnt Amber** (`amber`): "Saved locally" draft label and the resolver's decision badge text.
- **Amber Wash** (`amber-light`): `mark` highlight on the local edit, decision badge fill. The local-change diff fill is the close `#f4dfc4`; the committed-change fill is green `#dce9cf`.
- **Focus Amber** (`focus-amber`): 3px focus outline at 5px offset, and the textarea caret. Related amber dots: proposal status `#a97136`, conflict `#a26134`.

### Neutral
- **Paper** (`paper`): page background.
- **Warm White** (`white`): note sheets, resolver panel, textarea, text on green.
- **Green Ink** (`ink`): headings and default text.
- **Body** (`body`): option-row paragraphs; evidence text in print.
- **Muted Olive** (`muted`): secondary text, labels, captions.
- **Hairline** (`line`): rules, dividers, pane borders.
- **Green Wash** (`green-light`): hero map panel. Related tints: `#e8ece2` conflict section band, `#e6ebdd` recommended option row, `#e9eddf` publish phase.

**The Authority Color Rule.** Solid green fill means "the committed, shared version" or "the selected action". Never decoration.

**The Amber Is Not Yet Shared Rule.** Amber marks things that are local, awaiting a decision, or only proposed. It never marks committed state.

## Typography

**Display Font:** Newsreader (Georgia, serif), locally hosted WOFF2 at 400 and 500
**Body Font:** DM Sans, declared as family `DM` (sans-serif), locally hosted WOFF2 at 400–700
**Mono:** `ui-monospace, monospace` at 0.82em, for commit hashes and API names

**Character:** A literary serif voice over a neutral sans. The serif also renders depicted note content, so sample notes read as real Markdown prose rather than UI.

### Hierarchy
- **Display** (hero h1): balanced wrap; the closing word in `em` renders upright at 400 in `#557446`. Grows to 92px on very wide screens and steps down on narrow ones.
- **Headline** (section h2): balanced wrap, often two short lines split by a line break. Closing h2 is a fixed 48px; the rollout heading uses the serif at 30px.
- **Title** (h3): 20px; component titles step down to 18–19px.
- **Lead** (hero intro): max 420px.
- **Body** (16px / 1.6): section-intro paragraphs max 510px; supporting text 13–15px.
- **Label** (11–12px): diagram labels, captions, badges, table heads. Tracking ranges 0.04–0.1em by context; uppercase labels ("1 / CAPTURE", "INTERACTIVE PROTOTYPE", "LOCAL", "COMMITTED") are written in caps, and only the draft label uses CSS uppercase.

**The Two Voices Rule.** Serif is for headings and depicted note content; never for controls or labels.

## Layout

- **Container:** `min(1240px, 100% - 112px)`, centered. Side gutters tighten at the 1100, 800, and 600px breakpoints (to 36, 22, and 20px per side).
- **Hero:** copy and diagram side by side on desktop (0.85fr / 1.15fr, 70px gap); the diagram stacks under the copy on narrow screens. Exact narrow-screen hero arrangement is provisional.
- **Section intro:** two-column heading and paragraph (1fr / 1fr, 80px gap), single column on phones. Sections pad 104px vertically on desktop, less on smaller screens.
- **Transaction strip:** four equal phases split by vertical hairlines; two columns on tablets.
- **Conflict workspace:** a sidebar plus main area inside one panel; diff panes sit side by side and stack on phones.
- **Evidence band:** 1.15fr / 0.85fr grid with a hairline divider; rollout steps in four columns, two on phones.
- **Breakpoints:** 1600px (min-width), 1100px, 800px (masthead nav hidden), 600px.
- **Print** hides interactive controls and repaints the evidence band on paper. **Reduced motion** removes transitions and smooth scrolling.

## Elevation & Depth

Flat and tonal. One shadow exists, on depicted note sheets (`0 6px 16px #0000000d`), to suggest paper resting on a surface. Everything else separates by tint (paper → green wash → forest green) and 1px hairlines.

**The Paper-Only Shadow Rule.** Shadows belong to depicted documents, never to UI panels or buttons.

## Shapes

Small, soft corners that grow with container size: 4px note sheets and badges, 5px controls, 6px buttons and diff panes, 10px phone note, 12px resolver and commit card, 18px hero map. Circles for status dots, commit nodes, and rollout step numbers. Borders are 1px hairlines. Icons are inline outline SVGs with a 1.6 stroke, mostly 15–21px. The declared `--radius: 14px` variable is unused.

## Components

### Buttons
- **Shape:** gently rounded (6px), min height 48px; a compact 40px variant sits in the resolver footer.
- **Primary:** forest green fill, warm-white text, 14px at 500, trailing arrow icon.
- **Hover / Focus:** background darkens over 0.18s; amber outline on focus-visible.
- **Disabled:** `#dfe3d9` fill, `#56604f` text, not-allowed cursor.

### Segmented and choice controls
- **Scenario controls:** transparent, muted text, 5px radius; hover `#e6e9df`; `aria-pressed="true"` fills forest green.
- **Resolver choices:** warm white with `#c9cebd` border; hover `#edf0e6`; pressed fills green.

### Cards / Containers
- **Hero map:** green wash panel holding white note sheets, a phone note, and the solid green commit-history card, with an "Illustrative" caption.
- **Resolver:** warm white, `#bdc8b7` border, 12px radius; file-list sidebar `#f2f4ec`; diff and result headers `#f5f5ee`.
- **Option rows:** full-width rows split by hairlines; the recommended row takes the `#e6ebdd` tint.

### Inputs / Fields
- **Textarea:** borderless warm white, 14px, inside the hairline-bordered result pane; amber caret and focus outline.

### Navigation
- **Masthead:** branch icon and bold brand left, 14px text links with 30px gaps, an external spec link right; hover shifts to amber `#9c522d`. Text links hide at 800px and below.

### Commit History Card (signature)
Solid forest green card listing short commits with hollow nodes on a vertical rule; the latest node fills pale lime `#d9e9a3` and carries an "Accepted commit" tag. This is the visual shorthand for GitHub authority.

### Transaction Strip (signature)
Four phases (Capture, Reconcile, Publish, Apply) with tracked step labels, 19px titles, muted 13px copy, and an underlined state pinned to the bottom. The Publish phase takes the `#e9eddf` tint and a bold state. Scenario buttons swap the copy in place (`aria-live="polite"`).

### Conflict Workspace (signature)
The central interactive piece: local and committed diff panes, four resolution choices, a result preview, and a "Confirm in demo" action. It is labelled "INTERACTIVE PROTOTYPE", and its states say "Simulation only" and "No real files were changed". A "Simulate a newer commit" control shows a decision being invalidated.

## Do's and Don'ts

### Do:
- **Do** use forest green fill only for committed authority and selected actions.
- **Do** label every synthetic example and simulated outcome in words ("Illustrative", "INTERACTIVE PROTOTYPE", "Simulation only").
- **Do** keep the proposal status visible ("Proposed design · not installed in your vault").
- **Do** explain with sample note text and commit history rather than abstract boxes.
- **Do** separate content with 1px hairlines and tonal panels.
- **Do** keep reading paragraphs within ~420–510px inside the 1240px container.

### Don't:
- **Don't** apply these tokens to the Obsidian plugin UI or treat them as an approved brand.
- **Don't** let a simulated state read as real sync or a released feature.
- **Don't** add shadows to panels or buttons; the paper-sheet shadow is the only one.
- **Don't** use Newsreader for controls, labels, or captions.

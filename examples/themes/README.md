# Themes

bytelight's entire visual design is driven by CSS custom properties (variables). To customize the look, create a CSS file that overrides the `:root` variables and import it in `packages/frontend/src/app.css`.

## How to apply a theme

1. Copy one of the example themes to your project:
   ```bash
   cp examples/themes/warm-earth.css packages/frontend/src/theme.css
   ```

2. Import it at the top of `packages/frontend/src/app.css`:
   ```css
   @import './theme.css';
   ```

3. Rebuild the frontend:
   ```bash
   npm run build --workspace=packages/frontend
   ```

## Available example themes

- **gold-hud.css** — Dark cyberpunk with gold accents, Cinzel headings, scan-line effects. The original design. Requires Google Fonts (Cinzel, Inter, JetBrains Mono).
- **warm-earth.css** — Cozy warm-toned dark theme with amber/brown palette.

## Creating your own theme

Override any of these CSS variables in your theme file:

### Colors
| Variable | Purpose |
|---|---|
| `--bg-primary` | Main background |
| `--bg-secondary` | Sidebar, header backgrounds |
| `--bg-tertiary` | Elevated surfaces |
| `--bg-surface` | Cards, panels |
| `--bg-input` | Input field backgrounds |
| `--text-primary` | Main text color |
| `--text-secondary` | Secondary text |
| `--text-muted` | Dimmed/hint text |
| `--text-accent` | Emphasized text |
| `--gold` | Primary accent color |
| `--gold-bright` | Hover/active accent |
| `--gold-dim` | Subtle accent |
| `--gold-glow` | Accent glow (rgba) |
| `--gold-ember` | Faint accent background (rgba) |

### Message bubbles
| Variable | Purpose |
|---|---|
| `--companion-bg` | Companion message background |
| `--companion-border` | Companion message border |
| `--user-bg` | User message background |
| `--user-border` | User message border |

### Status indicators
| Variable | Purpose |
|---|---|
| `--status-active` | Online/active dot |
| `--status-waking` | Waking up dot |
| `--status-dormant` | Idle dot |
| `--status-offline` | Offline dot |

### Typography
| Variable | Purpose |
|---|---|
| `--font-heading` | Headings font stack |
| `--font-body` | Body text font stack |
| `--font-mono` | Code/monospace font stack |

### Light mode
Define a `[data-theme="light"]` block in your theme to customize light mode separately.

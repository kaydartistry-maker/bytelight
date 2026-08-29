<!--
  ThemePreviewCard — a live sample (header + bubbles + buttons) that mirrors the
  current theme. It inherits the CSS variables applied to <html> by the theme
  store, so it reflects mode, accent, fonts, radius AND the effect sliders
  (aura/glow/motion) in real time. Self-contained: its Cosmos treatment reads the
  same --fx-aura / --fx-glow multipliers as the main app, so the sliders move it
  without depending on chat-route-scoped styles.
-->
<div class="preview-card" aria-hidden="true">
  <div class="pv-header">
    <span class="pv-title">Live Preview</span>
    <span class="pv-dot"></span>
  </div>

  <div class="pv-bubble pv-companion">How's the vibe looking?</div>
  <div class="pv-bubble pv-user">Cosmic. ✨</div>

  <div class="pv-actions">
    <span class="res-btn res-btn--primary res-btn--sm">Primary</span>
    <span class="res-btn res-btn--ghost res-btn--sm">Ghost</span>
  </div>
</div>

<style>
  .preview-card {
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-secondary);
  }

  .pv-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--border);
  }

  .pv-title {
    font-family: var(--font-heading);
    font-size: 0.9rem;
    letter-spacing: 0.03em;
    color: var(--text-accent, var(--gold));
  }

  .pv-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--gold);
  }

  .pv-bubble {
    max-width: 82%;
    margin: 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-family: var(--font-body);
    font-size: 0.8125rem;
    line-height: 1.45;
    color: var(--text-primary);
  }

  .pv-companion {
    align-self: flex-start;
    background: var(--companion-bg, var(--bg-surface));
  }

  .pv-user {
    align-self: flex-end;
    background: var(--user-bg, var(--gold-ember));
  }

  .pv-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.2rem;
  }

  /* Cosmos: mirror the app's aura wash + bubble glow, scaled by the same
     --fx-aura / --fx-glow multipliers the Effects sliders drive. */
  :global(html[data-skin="cosmos"]) .preview-card {
    background:
      radial-gradient(120% 80% at 90% 0%, rgba(var(--aura-violet), calc(0.10 * var(--fx-aura, 1))), transparent 60%),
      radial-gradient(100% 70% at 0% 100%, rgba(var(--aura-rose), calc(0.06 * var(--fx-aura, 1))), transparent 55%),
      var(--bg-secondary);
  }

  :global(html[data-skin="cosmos"]) .pv-companion {
    background: linear-gradient(165deg, rgba(var(--aura-violet), calc(0.13 * var(--fx-aura, 1))), rgba(var(--aura-violet), calc(0.035 * var(--fx-aura, 1))));
    border-color: rgba(var(--aura-violet), 0.22);
    box-shadow: 0 10px 28px -18px rgba(var(--aura-violet), calc(0.6 * var(--fx-glow, 1)));
  }

  :global(html[data-skin="cosmos"]) .pv-user {
    background: linear-gradient(165deg, rgba(var(--aura-rose), calc(0.15 * var(--fx-aura, 1))), rgba(var(--aura-rose), calc(0.04 * var(--fx-aura, 1))));
    border-color: rgba(var(--aura-rose), 0.26);
    box-shadow: 0 10px 28px -18px rgba(var(--aura-rose), calc(0.55 * var(--fx-glow, 1)));
  }
</style>

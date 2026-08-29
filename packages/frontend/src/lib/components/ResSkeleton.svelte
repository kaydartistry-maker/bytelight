<script lang="ts">
  let { variant = 'list', rows = 3 }: {
    variant: 'list' | 'cards' | 'stats' | 'calendar' | 'form';
    rows?: number;
  } = $props();
</script>

<div class="skeleton" aria-hidden="true" aria-label="Loading">
  {#if variant === 'stats'}
    <div class="skeleton__stats">
      <div class="res-skeleton res-skeleton--card"></div>
      <div class="res-skeleton res-skeleton--card"></div>
      <div class="res-skeleton res-skeleton--card"></div>
    </div>
  {:else if variant === 'cards'}
    <div class="skeleton__cards">
      {#each Array(rows) as _}
        <div class="res-skeleton res-skeleton--card"></div>
      {/each}
    </div>
  {:else if variant === 'calendar'}
    <div class="skeleton__calendar">
      {#each Array(7) as _}
        <div class="res-skeleton res-skeleton--circle"></div>
      {/each}
    </div>
    <div class="skeleton__bars">
      {#each Array(3) as _}
        <div class="res-skeleton res-skeleton--bar"></div>
      {/each}
    </div>
  {:else if variant === 'form'}
    <div class="skeleton__form">
      <div class="res-skeleton res-skeleton--bar" style="width: 40%; height: 12px;"></div>
      <div class="skeleton__chips">
        {#each Array(5) as _}
          <div class="res-skeleton" style="width: 80px; height: 44px; border-radius: 22px;"></div>
        {/each}
      </div>
      <div class="res-skeleton res-skeleton--bar" style="width: 30%; height: 12px; margin-top: var(--space-4);"></div>
      {#each Array(3) as _}
        <div class="res-skeleton res-skeleton--bar"></div>
      {/each}
    </div>
  {:else}
    <!-- list variant (default) -->
    <div class="skeleton__list">
      {#each Array(rows) as _}
        <div class="skeleton__row">
          <div class="res-skeleton res-skeleton--circle" style="width: 22px; height: 22px;"></div>
          <div class="res-skeleton res-skeleton--bar" style="flex: 1;"></div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .skeleton { padding: var(--space-2) 0; }

  .skeleton__stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-3);
  }

  .skeleton__cards {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .skeleton__calendar {
    display: flex;
    gap: var(--space-3);
    justify-content: space-around;
    margin-bottom: var(--space-4);
  }

  .skeleton__bars {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .skeleton__form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .skeleton__chips {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .skeleton__list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .skeleton__row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
</style>

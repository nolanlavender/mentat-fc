import { test, expect } from '@playwright/test';

// End-to-end: register a fresh account, view a team dashboard, log a bet,
// and confirm it shows up in the tracked list. Deliberately the one E2E
// test in this project (see docs/PHASES.md's Phase 9) -- everything else
// is covered by unit tests (pure logic) or this project's established
// habit of manual real-browser verification per change. This one exists
// because "does registering, navigating, and submitting a form actually
// work together, through the real backend, against a real database" isn't
// a question any unit test can answer -- it's the one thing worth paying
// an E2E test's slowness/fragility cost for.
//
// Requires a real Postgres (migrated) and the backend dev server already
// running, with at least one upcoming Premier League fixture seeded --
// see e2e/README.md. This is true of any normal local dev setup for this
// project (npm run db:seed:current-season pulls the live schedule), so no
// special fixture/seed step is baked into this test itself.
test('register, view a team dashboard, log a bet, see it tracked', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;
  const password = 'testpassword123';

  // Unauthenticated /bets redirects to /login -- the RequireAuth guard.
  await page.goto('/bets');
  await expect(page).toHaveURL(/\/login/);

  // Switch from the default login mode to register, then submit.
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Register', exact: true }).click();

  // A successful register navigates to /bets and the nav shows who's logged in.
  await expect(page).toHaveURL(/\/bets/);
  await expect(page.getByText(email)).toBeVisible();

  // View a team dashboard, via the Teams nav dropdown (a click-to-toggle
  // button + panel, not a plain link -- see TeamsNavDropdown.tsx).
  await page.getByRole('button', { name: 'Teams' }).click();
  await page.locator('.teams-nav-panel a').first().click();
  await expect(page.getByRole('heading', { name: 'Squad' })).toBeVisible();

  // Log a bet: wait for the upcoming-fixtures fetch to actually resolve
  // before interacting with the dropdown it populates.
  const fixturesLoaded = page.waitForResponse((res) => /\/api\/fixtures\?/.test(res.url()) && res.status() === 200);
  await page.getByRole('link', { name: 'Bets' }).click();
  await fixturesLoaded;

  await page.getByLabel('Fixture').selectOption({ index: 1 });
  await page.getByLabel('Pick').selectOption('home');
  await page.getByLabel('Leg odds (decimal)').fill('2.50');
  await page.getByRole('button', { name: 'Add leg' }).click();
  await expect(page.locator('.draft-legs')).toContainText('2.50');

  await page.getByLabel('Stake ($)').fill('10');
  await page.getByRole('button', { name: 'Log bet', exact: true }).click();

  // See it tracked: the new bet appears in "All bets", pending (nothing's
  // been settled), for the stake just entered.
  const firstBetCard = page.locator('.bet-card').first();
  await expect(firstBetCard).toBeVisible();
  await expect(firstBetCard).toContainText('$10.00');
  // Scoped to the card header's overall-result badge specifically -- each
  // leg row has its own (also initially "pending") result badge with the
  // same class, so an unscoped locator here matches two elements.
  await expect(firstBetCard.locator('.bet-card-header .bet-result-pending')).toBeVisible();
});

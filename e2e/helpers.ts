import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export async function signIn(page: Page, email: string, org = 'acme') {
  await page.goto('/login');
  await page.getByLabel('Organization').fill(org);
  await page.getByRole('button', { name: 'Continue with single sign-on' }).click();
  await page.waitForURL(/localhost:4110\/authorize/);
  await page.locator('select[name=email]').selectOption(email);
  await page.locator('input[name=otp]').fill('246810');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/cases/);
}

/** Opens a case from the queue, looking at open cases first and then closed ones. */
export async function openCase(page: Page, name: RegExp | string) {
  await page.goto('/cases');
  for (const tab of ['All open', 'Closed']) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
    // wait until the list for this tab has rendered (rows or the empty message)
    await page.locator('tbody tr').or(page.getByText('No cases match')).first().waitFor();
    await page.waitForLoadState('networkidle');
    const row = page.getByRole('row', { name });
    if ((await row.count()) > 0) {
      await row.first().click();
      await page.waitForURL(/\/cases\/[0-9a-f-]{36}/);
      return;
    }
  }
  throw new Error(`case ${String(name)} not found`);
}

/** Fails on serious or critical WCAG 2.x A/AA violations. */
export async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
}

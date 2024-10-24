import { bankStatement } from '@fingraph/fixtures';
import { expect, test } from '@playwright/test';
import { expectAccessible, openCase, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });

test('WF-01: onboarding uploads a document and it is processed', async ({ page }) => {
  await signIn(page, 'omar.onboarding@acme.test');
  await openCase(page, /Bayside Remit Inc/);
  await page.getByRole('tab', { name: /Evidence/ }).click();
  const pdf = await bankStatement();
  await page.locator('input[type=file]').first().setInputFiles({ name: 'bayside-statement.pdf', mimeType: 'application/pdf', buffer: pdf });
  const doc = page.getByRole('button', { name: /bayside-statement/ });
  await expect(doc).toBeVisible();
  await expect(doc).toContainText(/to review|Reviewed/, { timeout: 30_000 });
  await doc.click();
  await expect(page.locator('mark.evidence').first()).toBeVisible();
});

test('WF-03: analyst reviews facts and escalates; risk manager approves', async ({ page, browser }) => {
  await signIn(page, 'ana.analyst@acme.test');
  await openCase(page, /KYB-\d\d-00001/);
  await expect(page.getByText(/Thomas Reid holds 27%/)).toBeVisible();

  // approve every critical field across documents
  await page.getByRole('tab', { name: /Evidence/ }).click();
  const docs = page.getByRole('list', { name: 'Documents' }).getByRole('button');
  await expect(docs.first()).toBeVisible();
  const count = await docs.count();
  expect(count).toBeGreaterThan(5);
  const approve = page.getByRole('button', { name: /^Approve / });
  for (let i = 0; i < count; i++) {
    await docs.nth(i).click();
    await page.waitForLoadState('networkidle');
    for (let n = await approve.count(); n > 0; n = await approve.count()) {
      await approve.first().click();
      // wait for the list to reflect the approval before counting again
      await expect.poll(() => approve.count()).toBeLessThan(n);
    }
  }
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByText('All critical fields are reviewed.')).toBeVisible();

  await page.getByRole('button', { name: 'Submit decision' }).click();
  const dialog = page.getByRole('dialog', { name: 'Submit recommendation' });
  await expect(dialog.getByText(/require escalation/)).toBeVisible();
  await dialog.getByLabel('Rationale').fill('Documents consistent; indirect owner Thomas Reid needs second-line review.');
  await dialog.getByRole('button', { name: 'Record decision' }).click();
  await expect(page.getByText('Escalated', { exact: true }).first()).toBeVisible();

  const riskContext = await browser.newContext();
  const risk = await riskContext.newPage();
  await signIn(risk, 'rita.risk@acme.test');
  await risk.getByRole('tab', { name: /Awaiting approval/ }).click();
  await risk.getByRole('row', { name: /Northwind Payments LLC/ }).first().click();
  await risk.getByRole('button', { name: 'Decide' }).click();
  const decide = risk.getByRole('dialog', { name: 'Decide as approver' });
  await decide.getByLabel('Rationale').fill('Verified Thomas Reid through Harbor Capital filings; acceptable.');
  await decide.getByRole('button', { name: 'Record decision' }).click();
  await expect(risk.getByText('Approved', { exact: true }).first()).toBeVisible();
  await risk.getByRole('tab', { name: 'Decisions' }).click();
  await expect(risk.getByText('Approver decision')).toBeVisible();
  await riskContext.close();
});

test('WF-04: evidence question with citations that open the source', async ({ page }) => {
  await signIn(page, 'sam.analyst@acme.test');
  await openCase(page, /Bayside Remit Inc/);
  await page.getByRole('tab', { name: 'Ask' }).click();
  await page.getByLabel(/Ask about this case/).fill('What was the closing balance on the bank statement?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const chip = page.locator('article').first().getByRole('button', { name: '1', exact: true });
  await expect(chip).toBeVisible();
  await chip.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.locator('mark.evidence[data-active="true"]')).toBeVisible();
  await expect(drawer.locator('mark.evidence[data-active="true"]')).toContainText(/balance|1,438,155/i);
});

test('WF-05: auditor exports a verifiable evidence package', async ({ page }) => {
  await signIn(page, 'ivy.auditor@acme.test');
  await page.getByRole('tab', { name: 'Closed' }).click();
  await page.getByRole('row', { name: /KYR-/ }).first().click();
  await page.waitForURL(/\/cases\/[0-9a-f-]{36}/);
  await page.getByRole('tab', { name: 'Exports' }).click();
  await page.getByRole('button', { name: 'Create evidence package' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download' }).first().click({ timeout: 30_000 });
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^evidence-.*\.zip$/);
});

test('tenant isolation: another organization cannot open a case by URL', async ({ page, browser }) => {
  const acme = await browser.newContext();
  const a = await acme.newPage();
  await signIn(a, 'ana.analyst@acme.test');
  await openCase(a, /KYB-\d\d-00001/);
  const url = a.url();
  await acme.close();
  await signIn(page, 'olga@globex.test', 'globex');
  await page.goto(url);
  await expect(page.getByText('Case not available')).toBeVisible();
  await expect(page.getByText('Northwind')).toHaveCount(0);
});

test('accessibility of the main screens', async ({ page }) => {
  await signIn(page, 'ana.analyst@acme.test');
  await expectAccessible(page);
  await openCase(page, /KYB-\d\d-00001/);
  await expectAccessible(page);
  await page.getByRole('tab', { name: /Evidence/ }).click();
  await page.waitForTimeout(500);
  await expectAccessible(page);
});

test('accessibility of dashboard, evidence questions and administration', async ({ page, browser }) => {
  await signIn(page, 'rita.risk@acme.test');
  await page.goto('/dashboard');
  await expect(page.getByText('Cases closed per week')).toBeVisible();
  await expectAccessible(page);
  await openCase(page, /Bayside Remit Inc/);
  await page.getByRole('tab', { name: 'Ask' }).click();
  await expect(page.getByText('Ask about this case')).toBeVisible();
  await expectAccessible(page);

  const admin = await browser.newContext();
  const a = await admin.newPage();
  await signIn(a, 'alex.admin@acme.test');
  for (const section of ['people', 'organization', 'policies', 'governance']) {
    await a.goto(`/admin/${section}`);
    await a.waitForLoadState('networkidle');
    await expectAccessible(a);
  }
  await admin.close();
});

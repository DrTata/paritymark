const { test, expect } = require('@playwright/test');
const {
  seedConfigActiveForLocale,
} = require('./seed.cjs');

test.describe('Assessment Debug page against live API', () => {
  test('renders assessment tree and summary in en-GB', async ({ page }) => {
    await page.goto('/assessment-debug');

    const loadButton = page.getByTestId('assessment-debug-load-button');
    await loadButton.click();

    const summary = page.getByTestId('assessment-debug-summary');
    await expect(summary).toContainText('HTTP Assessment Test (D_ASSESS_HTTP)');
    await expect(summary).toContainText('1 series');
    await expect(summary).toContainText('1 paper');
    await expect(summary).toContainText('1 QIG');
    await expect(summary).toContainText('1 item');

    // Title should be the English assessment debug title
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toHaveText('Assessment Debug');
  });

  test('renders French assessment debug messages when ui.locale=fr-FR', async ({ page }) => {
    // Re-seed config for D1 with a French locale
    await seedConfigActiveForLocale('fr-FR');

    await page.goto('/assessment-debug');

    const loadButton = page.getByTestId('assessment-debug-load-button');
    await loadButton.click();

    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toHaveText('Débogage des évaluations');

    const description = page.getByTestId('assessment-debug-description');
    await expect(description).toContainText('Vue de débogage');

    await expect(loadButton).toHaveText("Charger l'arbre d'évaluation");
  });
});

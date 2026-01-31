import { Page } from 'playwright';
import { logger } from '../../logger';

/**
 * Currency code mappings and variations
 */
const CURRENCY_VARIATIONS: Record<string, string[]> = {
  'SBPRUB': ['SBERRUB', 'SBPRUB', 'SBRUB', 'CARDSBERRUB', 'SBERBANKSPP'],
  'CARDRUB': ['CARDRUB', 'TCSBRUB', 'ACRUB', 'SBERRUB', 'CARDSBERRUB'],
  'BTC': ['BTC', 'BITCOIN'],
  'ETH': ['ETH', 'ETHEREUM', 'ETHERC20'],
  'USDTTRC20': ['USDTTRC20', 'USDTTRC', 'USDTTRX', 'TRCUSDT', 'USDTRON'],
  'USDTERC20': ['USDTERC20', 'USDTERC', 'USDTETH', 'ERCUSDT', 'USDETH'],
};

const CURRENCY_NAMES: Record<string, string[]> = {
  'BTC': ['BTC', 'Bitcoin', 'Биткоин'],
  'ETH': ['ETH', 'Ethereum', 'Эфириум'],
  'USDTTRC20': ['USDT TRC20', 'Tether TRC20', 'USDT TRC-20', 'TRC20', 'USDT'],
  'USDTERC20': ['USDT ERC20', 'Tether ERC20', 'USDT ERC-20', 'ERC20'],
  'LTC': ['LTC', 'Litecoin', 'Лайткоин'],
  'CARDUAH': ['UAH', 'Приватбанк', 'Карта UAH', 'ПриватБанк', 'Monobank', 'Visa UAH', 'Украина'],
  'SBPRUB': ['Сбербанк', 'СБП', 'SBP', 'Сбербанк RUB', 'SBER'],
  'CARDRUB': ['Тинькофф', 'Tinkoff', 'Альфа-Банк', 'Alfa', 'Карта RUB', 'Card RUB']
};

export function getCurrencyVariations(code: string): string[] {
  return CURRENCY_VARIATIONS[code] || [code];
}

export function getCurrencyNames(code: string): string[] {
  return CURRENCY_NAMES[code] || [code];
}

/**
 * Navigate to exchange page using direct URL patterns
 */
export async function navigateToExchangePage(
  page: Page,
  fromCurrency: string,
  toCurrency: string
): Promise<boolean> {
  const baseUrl = new URL(page.url()).origin;
  const fromVariations = getCurrencyVariations(fromCurrency);
  const toVariations = getCurrencyVariations(toCurrency);
  const urlPrefixes = ['exchange', 'xchange'];

  for (const prefix of urlPrefixes) {
    for (const fromCode of fromVariations) {
      for (const toCode of toVariations) {
        const directUrl = `${baseUrl}/${prefix}_${fromCode}_to_${toCode}/`;
        logger.info(`Trying URL: ${directUrl}`);

        try {
          await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(2000);

          const is404 = await page.evaluate(() => {
            const text = document.body?.innerText?.toLowerCase() || '';
            const title = document.title?.toLowerCase() || '';
            return text.includes('404') || text.includes('не найден') ||
                   text.includes('not found') || title.includes('404') ||
                   (document.body?.innerText?.length || 0) < 500;
          });

          if (!is404) {
            logger.info(`Found valid exchange page: ${directUrl}`);
            return true;
          }
        } catch {
          continue;
        }
      }
    }
  }

  return false;
}

/**
 * Select currencies via UI (fallback method)
 */
export async function selectCurrenciesViaUI(
  page: Page,
  fromCurrency: string,
  toCurrency: string
): Promise<boolean> {
  const fromNames = getCurrencyNames(fromCurrency);
  const toNames = getCurrencyNames(toCurrency);

  // Strategy 1: Dropdown selection
  if (await tryDropdownSelection(page, fromCurrency, toCurrency)) return true;

  // Strategy 2: List-based selection
  if (await tryListBasedSelection(page, fromNames, toNames)) return true;

  // Strategy 3: Text-based selection
  if (await tryTextBasedSelection(page, fromNames, toNames)) return true;

  logger.warn('Could not select currencies via UI');
  return false;
}

async function tryDropdownSelection(page: Page, fromCurrency: string, toCurrency: string): Promise<boolean> {
  const fromSelectors = [
    '.xchange_select1 .cur_label',
    '.from-currency .cur_label',
    '#select1 .cur_label',
    '.select_cur1',
    '[data-currency-from]'
  ];

  for (const selector of fromSelectors) {
    try {
      const fromSelect = await page.$(selector);
      if (fromSelect && await fromSelect.isVisible()) {
        await fromSelect.click();
        await page.waitForTimeout(500);

        const fromOption = await page.$(`[data-cur="${fromCurrency}"], [data-currency="${fromCurrency}"], .cur_item:has-text("${fromCurrency}")`);
        if (fromOption) {
          await fromOption.click();
          logger.info(`Selected from currency: ${fromCurrency}`);
          await page.waitForTimeout(1000);

          const toSelectors = ['.xchange_select2 .cur_label', '.to-currency .cur_label', '#select2 .cur_label'];
          for (const toSel of toSelectors) {
            const toSelect = await page.$(toSel);
            if (toSelect && await toSelect.isVisible()) {
              await toSelect.click();
              await page.waitForTimeout(500);
              const toOption = await page.$(`[data-cur="${toCurrency}"], [data-currency="${toCurrency}"], .cur_item:has-text("${toCurrency}")`);
              if (toOption) {
                await toOption.click();
                logger.info(`Selected to currency: ${toCurrency}`);
                return true;
              }
            }
          }
        }
      }
    } catch { continue; }
  }
  return false;
}

async function tryListBasedSelection(page: Page, fromNames: string[], toNames: string[]): Promise<boolean> {
  for (const name of fromNames) {
    try {
      const leftListSelectors = [
        `.currency-list:first-child li:has-text("${name}")`,
        `.left-column li:has-text("${name}")`,
        `.cur_list:first-of-type .cur_item:has-text("${name}")`,
        `nav li:has-text("${name}")`,
        `li:has-text("${name}")`
      ];

      for (const selector of leftListSelectors) {
        const el = await page.$(selector);
        if (el && await el.isVisible()) {
          await el.click();
          logger.info(`Clicked from currency: ${name}`);
          await page.waitForTimeout(2000);

          for (const toName of toNames) {
            const rightSelectors = [
              `.right-column a:has-text("${toName}")`,
              `.directions a:has-text("${toName}")`,
              `main a:has-text("${toName}")`,
              `tr a:has-text("${toName}")`
            ];

            for (const toSel of rightSelectors) {
              try {
                const toEl = await page.$(toSel);
                if (toEl && await toEl.isVisible()) {
                  await toEl.click();
                  logger.info(`Clicked direction: ${toName}`);
                  return true;
                }
              } catch { continue; }
            }
          }
          break;
        }
      }
    } catch { continue; }
  }
  return false;
}

async function tryTextBasedSelection(page: Page, fromNames: string[], toNames: string[]): Promise<boolean> {
  for (const fromName of fromNames) {
    try {
      const el = await page.locator(`text=${fromName}`).first();
      if (await el.isVisible()) {
        await el.click();
        logger.info(`Clicked from text: ${fromName}`);
        await page.waitForTimeout(2000);

        for (const toName of toNames) {
          const toCode = toName.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
          const linkSelectors = [
            `a[href*="-to-${toCode}"]`,
            `a[href*="_to_${toCode}"]`,
            `main a:has-text("${toName}")`
          ];

          for (const linkSel of linkSelectors) {
            try {
              const link = await page.$(linkSel);
              if (link && await link.isVisible()) {
                await link.click();
                logger.info(`Clicked exchange link`);
                return true;
              }
            } catch { continue; }
          }
        }
      }
    } catch { continue; }
  }
  return false;
}

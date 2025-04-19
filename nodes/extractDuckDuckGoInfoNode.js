// nodes/extractDuckDuckGoInfoNode.js
import { log } from '../tools.js';

/**
 * Extracts press quotes and FAQs from the DuckDuckGo homepage.
 * @param {object} context - The node context, expects Puppeteer page in context.page
 * @returns {Promise<object>} - Returns context with extracted pressQuotes and faqs
 */
export async function extractDuckDuckGoInfoNode(context) {
  const { page } = context;
  log('ExtractDuckDuckGoInfoNode: Extracting press quotes and FAQs from DuckDuckGo homepage.');

  // Extract Press Quotes
  const pressQuotes = await page.$$eval('.flameSection_pressQuoteText__Fc2gV', nodes =>
    nodes.map(node => {
      const quote = node.innerText.trim();
      // Try to find the source in the closest figure/cite
      const cite = node.closest('figure')?.querySelector('cite span, cite')?.innerText.trim() || '';
      return { quote, source: cite };
    })
  );

  // Extract FAQs
  const faqs = await page.$$eval('.accordion_accordionItem__cB73r', items =>
    items.map(item => {
      const question = item.querySelector('.accordion_accordionHeader__eQ9AT')?.innerText.trim() || '';
      const answer = item.querySelector('.accordion_accordionContent__k7eWV')?.innerText.trim() || '';
      return { question, answer };
    })
  );

  log(`Extracted ${pressQuotes.length} press quotes and ${faqs.length} FAQs.`);
  return { ...context, pressQuotes, faqs, nextNode: 'finish' };
}

// Hybrid approach: Use Puppeteer for navigation/search, then LangChain CheerioWebBaseLoader for robust content extraction from each result URL
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";

/**
 * Fetches and extracts the visible text content from a given URL using LangChain CheerioWebBaseLoader.
 * @param {string} url - The URL of the page to extract.
 * @returns {Promise<string>} The visible text content of the page.
 */
export async function extractPageContentWithLangChain(url) {
  const loader = new CheerioWebBaseLoader(url);
  const docs = await loader.load();
  // docs[0].pageContent contains the visible text
  return docs[0]?.pageContent || '';
}

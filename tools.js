import { Tool } from '@langchain/core/tools';
import { z } from 'zod';

class NavigateToUrl extends Tool {
  constructor(page) {
    super();
    this.page = page;
    this.name = 'navigate_to_url';
    this.description = 'Navigate to a specified URL and return the page content.';
    this.schema = z.object({
      url: z.string().describe('The URL to navigate to'),
    });
  }

  async call(input) {
    const { url } = this.schema.parse(input);
    console.log('Navigating to URL:', input);
    await this.page.goto(url, { waitUntil: 'networkidle2' });
    return await this.page.content();
  }
}

class ClickElement extends Tool {
  constructor(page) {
    super();
    this.page = page;
    this.name = 'click_element';
    this.description = 'Click on an element using its CSS selector and return the updated page content.';
    this.schema = z.object({
      selector: z.string().describe('The CSS selector of the element to click'),
    });
  }

  async call(input) {
    const { selector } = this.schema.parse(input);
    console.log('Clicking element:', input);
    let navigationPromise = null;
    try {
      await this.page.waitForSelector(selector, { timeout: 5000 });
      navigationPromise = this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 7000 }).catch(() => {});
      await this.page.click(selector);
    } catch (err) {
      console.warn(`Selector '${selector}' not found. Fallback: simulating Enter key in search input.`);
      // Try to focus the search input and press Enter
      try {
        navigationPromise = this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 7000 }).catch(() => {});
        await this.page.focus("input[name='q']");
        await this.page.keyboard.press('Enter');
      } catch (e2) {
        throw new Error(`Click and Enter fallback failed: ${e2.message}`);
      }
    }
    if (navigationPromise) {
      await navigationPromise;
    }
    return await this.page.content();
  }
}

class TypeText extends Tool {
  constructor(page) {
    super();
    this.page = page;
    this.name = 'type_text';
    this.description = 'Type text into an input field identified by a CSS selector.';
    this.schema = z.object({
      selector: z.string().describe('The CSS selector of the input field'),
      text: z.string().describe('The text to type into the input field'),
    });
  }

  async call(input) {
    const { selector, text } = this.schema.parse(input);
    console.log('Typing:', input);
    await this.page.waitForSelector(selector, { timeout: 5000 });
    await this.page.type(selector, text);
    return await this.page.content();
  }
}

class ExtractText extends Tool {
  constructor(page) {
    super();
    this.page = page;
    this.name = 'extract_text';
    this.description = 'Extract text from an element identified by a CSS selector.';
    this.schema = z.object({
      selector: z.string().describe('The CSS selector of the element to extract text from'),
    });
  }

  async call(input) {
    const { selector } = this.schema.parse(input);
    console.log('Extracting text from:', input);
    const selectorsToTry = [
      selector,
      ".result__title a",
      ".react-results--main .react-results__title a",
      "a[data-testid='result-title-a']",
      "h2 a"
    ];
    let lastError = null;
    for (const sel of selectorsToTry) {
      try {
        await this.page.waitForSelector(sel, { timeout: 4000 });
        const text = await this.page.$eval(sel, el => el.textContent.trim());
        console.log(`Extracted text using selector: ${sel}`);
        return text;
      } catch (err) {
        console.warn(`Failed to extract with selector '${sel}': ${err.message}`);
        lastError = err;
      }
    }
    throw new Error(`All selectors failed for DuckDuckGo result title. Last error: ${lastError && lastError.message}`);
  }
}

export function createTools(page) {
  return [
    new NavigateToUrl(page),
    new ClickElement(page),
    new TypeText(page),
    new ExtractText(page),
  ];
}
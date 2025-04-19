// Utility to check and auto-fill missing selectors for DuckDuckGo
import { extractQueryFromTask } from './extractQueryFromTask.js';

export function ensureSelectorForTypeAction(context) {
  const { action, args = {}, page, task } = context;
  if (action === 'type') {
    let url = '';
    if (page && typeof page.url === 'function') {
      try {
        url = page.url();
      } catch (e) {
        url = '';
      }
    }
    let selector = args.selector && args.selector.trim() ? args.selector : '';
    if (!selector && /duckduckgo\.com/.test(url)) {
      selector = "input[name='q']";
    } else if (!selector) {
      selector = "input[name='q']";
    }
    let text = args.text && args.text.trim() ? args.text : '';
    if (!text) {
      text = extractQueryFromTask ? extractQueryFromTask(task) : '';
    }
    // Only autofill if we have at least selector and text
    if (selector && text) {
      return { ...context, args: { ...args, selector, text }, autoFilledSelector: true };
    }
    // If still missing required args, return context as is
    return context;
  }
  return context;
}

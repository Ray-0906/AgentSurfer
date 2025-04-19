export async function extractWithSelectorNode(context) {
  const { page, log, extractionSelector, extractionIndex, candidateSelectors } = context;
  log('Extract With Selector Node: Attempting extraction with selector:', extractionSelector, 'index:', extractionIndex);
  let lastError = null;
  const tried = new Set();

  // Try the LLM-chosen selector and index first
  try {
    await page.waitForSelector(extractionSelector, { timeout: 4000 });
    const elements = await page.$$(extractionSelector);
    if (elements.length > extractionIndex) {
      const el = elements[extractionIndex];
      const text = await page.evaluate(el => el.textContent.trim(), el);
      if (text && text.length > 0) {
        log('Extracted text (LLM-chosen):', text);
        return { ...context, finalResult: text, nextNode: 'endNode' };
      }
    }
    log('LLM-chosen selector found, but no element at index or empty text.');
  } catch (err) {
    log('Extraction failed for LLM-chosen selector', extractionSelector, `[${extractionIndex}]:`, err.message);
    lastError = err;
  }

  // Fallback: Try candidateSelectors by index (robust for arbitrary sites)
  log('LLM-chosen selector failed or empty. Attempting fallback with candidateSelectors...');
  log('candidateSelectors.length:', candidateSelectors.length);
  if (candidateSelectors && candidateSelectors.length > 0) {
    let mainTried = false;
    // Try the extractionIndex-th candidate first (if in range)
    if (typeof extractionIndex === 'number' && extractionIndex >= 0 && extractionIndex < candidateSelectors.length) {
      const fallback = candidateSelectors[extractionIndex];
      if (!tried.has(fallback.selector + fallback.index)) {
        tried.add(fallback.selector + fallback.index);
        try {
          await page.waitForSelector(fallback.selector, { timeout: 2000 });
          const elements = await page.$$(fallback.selector);
          if (elements.length > fallback.index) {
            const el = elements[fallback.index];
            const text = await page.evaluate(el => el.textContent.trim(), el);
            if (text && text.length > 0) {
              log(`Extracted text (candidateSelectors fallback, extractionIndex): [${fallback.selector}][${fallback.index}]`, text);
              return { ...context, finalResult: text, nextNode: 'endNode' };
            }
          }
        } catch (err) {
          log('Fallback extraction failed for extractionIndex candidate', fallback.selector, `[${fallback.index}]:`, err.message);
          lastError = err;
        }
        mainTried = true;
      }
    }
    // Try all other candidates (except the one already tried)
    for (let i = 0; i < candidateSelectors.length; ++i) {
      if (mainTried && i === extractionIndex) continue;
      const fallback = candidateSelectors[i];
      if (tried.has(fallback.selector + fallback.index)) continue;
      tried.add(fallback.selector + fallback.index);
      try {
        await page.waitForSelector(fallback.selector, { timeout: 2000 });
        const elements = await page.$$(fallback.selector);
        if (elements.length > fallback.index) {
          const el = elements[fallback.index];
          const text = await page.evaluate(el => el.textContent.trim(), el);
          if (text && text.length > 0) {
            log(`Extracted text (candidateSelectors fallback): [${fallback.selector}][${fallback.index}]`, text);
            return { ...context, finalResult: text, nextNode: 'endNode' };
          }
        }
      } catch (err) {
        log('Fallback extraction failed for', fallback.selector, `[${fallback.index}]:`, err.message);
        lastError = err;
      }
    }
  }
  // If all else fails
  return { ...context, finalResult: `Extraction failed: ${lastError ? lastError.message : 'No candidates matched.'}`, nextNode: 'endNode' };
}

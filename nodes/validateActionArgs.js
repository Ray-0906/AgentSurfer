// Utility to validate required arguments for agent actions
export function validateActionArgs(action, args) {
  // For type, click, extract: selector must be present and non-empty string
  const needsSelector = ['type', 'click', 'extract'];
  if (needsSelector.includes(action)) {
    if (!args || typeof args.selector !== 'string' || !args.selector.trim()) {
      return false;
    }
  }
  // For type: text must be present and non-empty string
  if (action === 'type') {
    if (!args || typeof args.text !== 'string' || !args.text.trim()) {
      return false;
    }
  }
  // For navigate: url must be present and non-empty string
  if (action === 'navigate') {
    if (!args || typeof args.url !== 'string' || !args.url.trim()) {
      return false;
    }
  }
  return true;
}

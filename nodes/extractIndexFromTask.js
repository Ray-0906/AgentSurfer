export function extractIndexFromTask(task) {
  const match = task.match(/extract the (\d+)(?:st|nd|rd|th)? result/i);
  if (match) return parseInt(match[1], 10) - 1;
  const words = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  const matchWord = task.match(/extract the (\w+) result/i);
  if (matchWord) {
    const idx = words.indexOf(matchWord[1].toLowerCase());
    if (idx !== -1) return idx;
  }
  return 0;
}

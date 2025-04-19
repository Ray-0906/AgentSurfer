export function extractQueryFromTask(task) {
  const match = task.match(/search for ['\"](.+?)['\"]/i) || task.match(/search for ([^,]+)/i);
  return match ? match[1] : 'AI agents';
}
 